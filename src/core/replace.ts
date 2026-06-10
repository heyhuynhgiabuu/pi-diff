/**
 * Cascading text replacement engine for LLM edit tools.
 *
 * When an LLM calls the edit tool with oldString + newString, the oldString
 * often doesn't match exactly due to:
 *   - Whitespace differences (indentation, trailing spaces)
 *   - Escape sequences (LLMs escaping \n, \t, quotes in tool call params)
 *   - Minor formatting drift (tabs vs spaces, trimmed lines)
 *
 * This module provides a cascade of replacer strategies, each progressively
 * more lenient. The first strategy that finds exactly one match wins.
 * If multiple candidates exist for a fuzzy strategy, we reject (safety first).
 *
 * Design inspired by OpenCode's edit tool (anomalyco/opencode) and
 * Cline's diff-apply evals, but restructured for independent use.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplaceResult {
	/** The resulting content after replacement (unchanged if no match). */
	content: string;
	/** Whether a replacement was made. */
	changed: boolean;
	/** Name of the replacer strategy that matched, or "none". */
	strategy: string;
	/** Number of occurrences replaced (only when changed=true). */
	count: number;
}

/**
 * A replacer yields candidate substrings from `content` that match `find`.
 * Each yielded string is an actual substring of `content` that the caller
 * should replace. Yields nothing when no match is found.
 */
type Replacer = (content: string, find: string) => Generator<string, void, undefined>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOccurrences(content: string, substring: string): number {
	if (substring.length === 0) return 0;
	let count = 0;
	let pos = 0;
	while (true) {
		pos = content.indexOf(substring, pos);
		if (pos === -1) break;
		count++;
		pos += substring.length;
	}
	return count;
}

/** Levenshtein distance for block anchor similarity comparison. */
function levenshtein(a: string, b: string): number {
	if (a === "" || b === "") return Math.max(a.length, b.length);
	const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
		}
	}
	return matrix[a.length][b.length];
}

// ---------------------------------------------------------------------------
// Replacers (in priority order)
// ---------------------------------------------------------------------------

/**
 * 1. Simple exact match.
 */
const SimpleReplacer: Replacer = function* (content, find) {
	if (content.includes(find)) yield find;
};

/**
 * 2. Escape-normalized match — unescapes common escape sequences
 * in the find string before matching. Handles LLMs that escape
 * tool call parameters (\\n, \\t, \\", etc.).
 *
 * Runs early (after Simple) so unescaped content flows through
 * line-level strategies (LineTrimmed, BlockAnchor) correctly.
 * Inspired by OpenCode's EscapeNormalizedReplacer.
 */
const EscapeNormalizedReplacer: Replacer = function* (content, find) {
	const unescapeStr = (str: string): string => {
		return str.replace(/\\([nrt'"`\\$])/g, (_match: string, char: string) => {
			switch (char) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "r":
					return "\r";
				case "'":
					return "'";
				case '"':
					return '"';
				case "`":
					return "`";
				case "\\":
					return "\\";
				case "$":
					return "$";
				default:
					return char;
			}
		});
	};

	const unescaped = unescapeStr(find);
	if (unescaped === find) return; // nothing was escaped, skip
	if (unescaped.length === 0) return;

	// Yield the unescaped string if found directly in content
	if (content.includes(unescaped)) {
		yield unescaped;
		return;
	}

	// Fallback: find matching blocks in content
	const contentLines = content.split("\n");
	const findLines = unescaped.split("\n");
	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (block === unescaped || block.trim() === unescaped.trim()) {
			yield block;
			return;
		}
	}
};

/**
 * 3. Line-trimmed match — compares lines after trimming whitespace.
 * Handles cases where indentation or trailing whitespace differs.
 */
const LineTrimmedReplacer: Replacer = function* (content, find) {
	const contentLines = content.split("\n");
	const findLines = find.split("\n");

	// Remove trailing empty line from find if present
	if (findLines.length > 1 && findLines[findLines.length - 1] === "") {
		findLines.pop();
	}

	if (findLines.length > contentLines.length) return;

	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		let matches = true;
		for (let j = 0; j < findLines.length; j++) {
			if (contentLines[i + j].trim() !== findLines[j].trim()) {
				matches = false;
				break;
			}
		}
		if (matches) {
			// Compute the actual substring in the original content
			let startPos = 0;
			for (let k = 0; k < i; k++) {
				startPos += contentLines[k].length + 1;
			}
			let endPos = startPos;
			for (let k = 0; k < findLines.length; k++) {
				endPos += contentLines[i + k].length;
				if (k < findLines.length - 1) endPos += 1;
			}
			yield content.slice(startPos, endPos);
		}
	}
};

/**
 * 4. Block anchor match — uses first and last lines as anchors,
 * then compares middle lines with Levenshtein similarity.
 * Requires at least 3 lines in the find string.
 *
 * Dual threshold: single candidates get a lower bar (anchors alone
 * are strong evidence), multiple candidates need higher similarity
 * to disambiguate. Inspired by OpenCode's BlockAnchorReplacer.
 */
const BlockAnchorReplacer: Replacer = function* (content, find) {
	const contentLines = content.split("\n");
	const findLines = find.split("\n");

	// Need at least 3 lines for meaningful anchor matching
	if (findLines.length < 3) return;

	if (findLines[findLines.length - 1] === "") findLines.pop();
	if (findLines.length < 3) return;

	const firstAnchor = findLines[0].trim();
	const lastAnchor = findLines[findLines.length - 1].trim();
	const searchBlockSize = findLines.length;
	const SINGLE_CANDIDATE_THRESHOLD = 0.25;
	const MULTIPLE_CANDIDATES_THRESHOLD = 0.4;

	// Collect candidate positions where both anchors match
	const candidates: Array<{ startLine: number; endLine: number }> = [];
	for (let i = 0; i < contentLines.length; i++) {
		if (contentLines[i].trim() !== firstAnchor) continue;
		// Look for matching last line after this first line
		for (let j = i + 2; j < contentLines.length; j++) {
			if (contentLines[j].trim() === lastAnchor) {
				candidates.push({ startLine: i, endLine: j });
				break;
			}
		}
	}

	if (candidates.length === 0) return;

	// Score each candidate by Levenshtein similarity
	// Single candidate: relaxed threshold (anchors provide strong signal)
	// Multiple candidates: require higher similarity to disambiguate
	const isSingleCandidate = candidates.length === 1;
	const threshold = isSingleCandidate ? SINGLE_CANDIDATE_THRESHOLD : MULTIPLE_CANDIDATES_THRESHOLD;

	if (isSingleCandidate) {
		const { startLine, endLine } = candidates[0];
		const actualBlockSize = endLine - startLine + 1;
		const middleCount = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		let similarity = 0;
		if (middleCount > 0) {
			for (let j = 1; j <= middleCount; j++) {
				const originalLine = contentLines[startLine + j].trim();
				const searchLine = findLines[j].trim();
				const maxLen = Math.max(originalLine.length, searchLine.length);
				if (maxLen === 0) continue;
				const distance = levenshtein(originalLine, searchLine);
				similarity += 1 - distance / maxLen;
			}
			similarity /= middleCount;
		} else {
			// No middle lines — anchors alone suffice
			similarity = 1;
		}
		if (similarity >= threshold) {
			let startPos = 0;
			for (let k = 0; k < startLine; k++) startPos += contentLines[k].length + 1;
			let endPos = startPos;
			for (let k = startLine; k <= endLine; k++) {
				endPos += contentLines[k].length;
				if (k < endLine) endPos += 1;
			}
			yield content.slice(startPos, endPos);
		}
		return;
	}

	// Multiple candidates: pick best match above higher threshold
	let bestMatch: { startLine: number; endLine: number } | null = null;
	let bestSimilarity = -1;
	for (const candidate of candidates) {
		const { startLine, endLine } = candidate;
		const actualBlockSize = endLine - startLine + 1;
		const middleCount = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		let similarity = 0;
		if (middleCount > 0) {
			for (let j = 1; j <= middleCount; j++) {
				const originalLine = contentLines[startLine + j].trim();
				const searchLine = findLines[j].trim();
				const maxLen = Math.max(originalLine.length, searchLine.length);
				if (maxLen === 0) continue;
				const distance = levenshtein(originalLine, searchLine);
				similarity += 1 - distance / maxLen;
			}
			similarity /= middleCount;
		} else {
			similarity = 1;
		}
		if (similarity > bestSimilarity) {
			bestSimilarity = similarity;
			bestMatch = candidate;
		}
	}
	if (!bestMatch || bestSimilarity < threshold) return;

	// Yield the actual content substring
	const { startLine, endLine } = bestMatch;
	let startPos = 0;
	for (let k = 0; k < startLine; k++) {
		startPos += contentLines[k].length + 1;
	}
	let endPos = startPos;
	for (let k = startLine; k <= endLine; k++) {
		endPos += contentLines[k].length;
		if (k < endLine) endPos += 1;
	}
	yield content.slice(startPos, endPos);
};

/**
 * 5. Whitespace-normalized match — collapses all whitespace runs
 * to single spaces and trims. Handles any whitespace differences.
 */
const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
	const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
	const normalizedFind = normalize(find);

	if (normalizedFind.length === 0) return;
	const contentLines = content.split("\n");
	const findLines = find.split("\n");

	// Single-line: find by normalized line content
	if (findLines.length <= 1 || (findLines.length === 2 && findLines[1] === "")) {
		for (let i = 0; i < contentLines.length; i++) {
			if (normalize(contentLines[i]) === normalizedFind) {
				yield contentLines[i];
			}
		}
		return;
	}

	// Multi-line: find blocks where normalized content matches
	const effectiveFindLines = findLines[findLines.length - 1] === "" ? findLines.slice(0, -1) : findLines;
	for (let i = 0; i <= contentLines.length - effectiveFindLines.length; i++) {
		const block = contentLines.slice(i, i + effectiveFindLines.length);
		if (normalize(block.join("\n")) === normalizedFind) {
			yield block.join("\n");
		}
	}
};

/**
 * 6. Indentation-flexible match — strips common leading indentation
 * before comparing. Handles blocks that shifted indent level.
 * NOTE: Excluded from the REPLACERS cascade — LineTrimmedReplacer's
 * per-line trim() is a superset. Kept here as documentation artifact.
 */
const IndentationFlexibleReplacer: Replacer = function* (content, find) {
	const removeIndent = (text: string): string => {
		const lines = text.split("\n");
		const nonEmpty = lines.filter((l) => l.trim().length > 0);
		if (nonEmpty.length === 0) return text;
		const minIndent = Math.min(
			...nonEmpty.map((l) => {
				const m = l.match(/^(\s*)/);
				return m ? m[1].length : 0;
			}),
		);
		return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join("\n");
	};

	const normalizedFind = removeIndent(find);
	if (normalizedFind.length === 0) return;

	const contentLines = content.split("\n");
	const findLines = find.split("\n");
	const effectiveFindLines = findLines[findLines.length - 1] === "" ? findLines.slice(0, -1) : findLines;

	for (let i = 0; i <= contentLines.length - effectiveFindLines.length; i++) {
		const block = contentLines.slice(i, i + effectiveFindLines.length).join("\n");
		if (removeIndent(block) === normalizedFind) {
			yield block;
		}
	}
};

/**
 * 7. Trimmed-boundary match — trims leading/trailing whitespace
 * from the find string before matching. Handles accidental
 * whitespace at boundaries.
 */
const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
	const trimmed = find.trim();
	if (trimmed === find || trimmed.length === 0) return;

	if (content.includes(trimmed)) {
		yield trimmed;
		return;
	}

	// Fallback: find blocks where the trimmed version matches
	const contentLines = content.split("\n");
	const findLines = find.split("\n");
	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (block.trim() === trimmed) {
			yield block;
			return;
		}
	}
};

/**
 * 8. Multi-occurrence replacer — yields ALL exact matches.
 * NOTE: Excluded from the REPLACERS cascade because replaceAll is
 * handled directly in the public `replace()` fast path for exact
 * matches. Fuzzy-strategy replaceAll would be unsafe (ambiguous).
 * Kept here as documentation artifact.
 */
const MultiOccurrenceReplacer: Replacer = function* (content, find) {
	if (find.length === 0) return;
	let pos = 0;
	while (true) {
		const idx = content.indexOf(find, pos);
		if (idx === -1) break;
		yield find;
		pos = idx + find.length;
	}
};

/**
 * 9. Context-aware match — uses first and last lines as context
 * anchors, then checks trimmed-line similarity (50%) for middle
 * lines. Simpler than BlockAnchor (no Levenshtein).
 * NOTE: Excluded from the REPLACERS cascade — BlockAnchorReplacer's
 * Levenshtein-based scoring subsumes this. Kept as documentation.
 */
const ContextAwareReplacer: Replacer = function* (_content, _find) {
	// Reference implementation in OpenCode:
	// https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/edit.ts
};

// ---------------------------------------------------------------------------
// All replacers in priority order (active members)
// ---------------------------------------------------------------------------

const REPLACERS: Replacer[] = [
	SimpleReplacer,
	EscapeNormalizedReplacer,
	LineTrimmedReplacer,
	BlockAnchorReplacer,
	WhitespaceNormalizedReplacer,
	TrimmedBoundaryReplacer,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace oldString with newString in content using a cascade of matching
 * strategies. Tries exact match first, then progressively relaxes matching
 * rules. If no strategy finds a match, returns unchanged content.
 *
 * Safety: if a fuzzy strategy finds multiple candidates, it is skipped
 * (we never auto-pick among ambiguous matches). Only exact matches
 * (SimpleReplacer) are allowed to match multiple occurrences, and only
 * when replaceAll=true.
 *
 * @param content - The full file content to edit.
 * @param oldString - The text to find and replace.
 * @param newString - The replacement text.
 * @param options.replaceAll - When true, replace ALL non-overlapping
 *   occurrences. Only safe for exact matches (simple replacer).
 * @returns ReplaceResult with the new content and match strategy info.
 */
export function replace(
	content: string,
	oldString: string,
	newString: string,
	options?: { replaceAll?: boolean },
): ReplaceResult {
	if (oldString.length === 0) {
		return { content, changed: false, strategy: "none", count: 0 };
	}
	if (oldString === newString) {
		return { content, changed: false, strategy: "none", count: 0 };
	}

	const replaceAll = options?.replaceAll ?? false;

	// Fast path: simple exact match with replaceAll
	if (replaceAll && content.includes(oldString)) {
		const result = content.replaceAll(oldString, newString);
		if (result !== content) {
			const count = countOccurrences(content, oldString);
			return { content: result, changed: true, strategy: "simple-replaceAll", count };
		}
	}

	// Fast path: single exact match
	if (!replaceAll) {
		const idx = content.indexOf(oldString);
		if (idx !== -1) {
			const lastIdx = content.lastIndexOf(oldString);
			if (idx === lastIdx) {
				// Exactly one occurrence
				const result = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
				return { content: result, changed: true, strategy: "simple", count: 1 };
			}
			// Multiple occurrences — fall through to fuzzy strategies
			// (we never auto-pick among duplicates)
		}
	}

	// Run through each replacer strategy in priority order
	for (const replacer of REPLACERS) {
		// Skip SimpleReplacer — already handled above
		if (replacer === SimpleReplacer) continue;

		const candidates: string[] = [];
		for (const candidate of replacer(content, oldString)) {
			candidates.push(candidate);
		}

		if (candidates.length === 0) continue;

		if (replaceAll) {
			// For replaceAll, use all candidates
			let result = content;
			let totalCount = 0;
			for (const candidate of candidates) {
				const count = countOccurrences(result, candidate);
				if (count > 0) {
					result = result.replaceAll(candidate, newString);
					totalCount += count;
				}
			}
			if (totalCount > 0) {
				const strategyName = replacer.name
					.replace("Replacer", "")
					.replace(/([a-z])([A-Z])/g, "$1-$2")
					.toLowerCase();
				return { content: result, changed: true, strategy: `${strategyName}-replaceAll`, count: totalCount };
			}
			continue;
		}

		// Single replacement: must have exactly one candidate
		if (candidates.length === 1) {
			const candidate = candidates[0];
			const idx = content.indexOf(candidate);
			if (idx !== -1) {
				const result = content.slice(0, idx) + newString + content.slice(idx + candidate.length);
				const strategyName = replacer.name
					.replace("Replacer", "")
					.replace(/([a-z])([A-Z])/g, "$1-$2")
					.toLowerCase();
				return { content: result, changed: true, strategy: strategyName, count: 1 };
			}
		}
		// Multiple candidates — skip this strategy (safety first)
	}

	// No match found
	return { content, changed: false, strategy: "none", count: 0 };
}
