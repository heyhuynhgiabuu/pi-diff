/**
 * resolve-lines.ts — Hunk-based line number resolution
 *
 * Matches an `existing_code` snippet from an LLM review comment against
 * parsed diff hunks to backfill `startLine`/`endLine`. Ported from
 * alibaba/open-code-review's internal/diff/resolver.go three-tier approach.
 *
 * Tiers:
 *   1. New-side match (context + added lines with new-file line numbers)
 *   2. Old-side match (context + deleted lines with old-file line numbers)
 *   3. File-content scan (consecutive match in full new-file content)
 */

import type { DiffLine, ParsedDiff } from "./diff.js";
import { parsePatchFiles } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedLines {
	startLine: number;
	endLine: number;
}

export interface Unresolved {
	unresolved: true;
}

export type LinesResult = ResolvedLines | Unresolved;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a single code line for comparison.
 * - Trims leading/trailing whitespace
 * - Strips leading `+` or `-` diff markers
 * - Re-trims after stripping
 */
function normalizeLine(s: string): string {
	s = s.trim();
	s = s.startsWith("+") || s.startsWith("-") ? s.slice(1).trim() : s.trim();
	return s;
}

/**
 * Split `existing_code` into normalized non-empty lines.
 * Empty lines after normalization are dropped (mirrors OCR behavior).
 */
function splitAndNormalize(code: string): string[] {
	const raw = code.split("\n");
	const result: string[] = [];
	for (const line of raw) {
		const n = normalizeLine(line);
		if (n === "") continue;
		result.push(n);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Hunk reconstruction
//
// pi-diff's ParsedDiff stores hunks as a flat DiffLine[] with sep lines
// carrying HunkMeta. We reconstruct structured hunks for side-by-side
// matching.
// ---------------------------------------------------------------------------

/** A side-indexed line with its absolute line number. */
interface IndexedLine {
	lineNum: number;
	content: string;
}

/** Reconstructed hunk with separate new-side and old-side line arrays. */
interface ResolveHunk {
	newSide: IndexedLine[];
	oldSide: IndexedLine[];
}

/**
 * Reconstruct hunks from a flat ParsedDiff.
 * Each `sep` marker with HunkMeta starts a new hunk. Context lines
 * appear on both sides; `add` lines on new-side only; `del` lines on
 * old-side only.
 */
function reconstructHunks(parsed: ParsedDiff): ResolveHunk[] {
	const hunks: ResolveHunk[] = [];
	let currentHunk: ResolveHunk | null = null;
	let oldNum = 0;
	let newNum = 0;

	for (const line of parsed.lines) {
		if (line.type === "sep" && line.hunkMeta) {
			// Start a new hunk (or the first one)
			currentHunk = { newSide: [], oldSide: [] };
			hunks.push(currentHunk);
			oldNum = line.hunkMeta.oldStart;
			newNum = line.hunkMeta.newStart;
			continue;
		}

		if (!currentHunk) continue; // lines before first sep — shouldn't happen

		switch (line.type) {
			case "ctx":
				currentHunk.newSide.push({ lineNum: newNum++, content: normalizeLine(line.content) });
				currentHunk.oldSide.push({ lineNum: oldNum++, content: normalizeLine(line.content) });
				break;
			case "add":
				currentHunk.newSide.push({ lineNum: newNum++, content: normalizeLine(line.content) });
				break;
			case "del":
				currentHunk.oldSide.push({ lineNum: oldNum++, content: normalizeLine(line.content) });
				break;
			// "sep" without hunkMeta (e.g., multi-edit separators) — skip
		}
	}

	return hunks;
}

// ---------------------------------------------------------------------------
// Sliding-window match
// ---------------------------------------------------------------------------

/**
 * Scan `sideLines` for a consecutive run matching all `targetLines`.
 * Returns the matching file line range, or undefined.
 */
function matchConsecutive(
	sideLines: IndexedLine[],
	targetLines: string[],
): { startLine: number; endLine: number } | undefined {
	if (targetLines.length === 0 || sideLines.length < targetLines.length) return undefined;

	for (let i = 0; i <= sideLines.length - targetLines.length; i++) {
		let matched = true;
		for (let j = 0; j < targetLines.length; j++) {
			if (sideLines[i + j].content !== targetLines[j]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return {
				startLine: sideLines[i].lineNum,
				endLine: sideLines[i + targetLines.length - 1].lineNum,
			};
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// File-content fallback
// ---------------------------------------------------------------------------

/**
 * Scan full file content line-by-line for a consecutive match of target lines.
 * Returns 1-based line numbers.
 */
function matchInFileContent(
	fileContent: string,
	targetLines: string[],
): { startLine: number; endLine: number } | undefined {
	if (!fileContent || targetLines.length === 0) return undefined;

	const fileLines = fileContent.split("\n");
	if (fileLines.length < targetLines.length) return undefined;

	for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
		let matched = true;
		for (let j = 0; j < targetLines.length; j++) {
			const fileLine = fileLines[i + j].replace(/\r$/, "").trim();
			if (fileLine !== targetLines[j]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return { startLine: i + 1, endLine: i + targetLines.length };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve line numbers for an `existing_code` snippet against a parsed diff.
 *
 * Tries three tiers:
 *   1. New-side hunk match (context + added lines)
 *   2. Old-side hunk match (context + deleted lines)
 *   3. Full file-content scan (if `fileContent` is provided)
 *
 * @param existingCode - The code snippet from the LLM comment
 * @param parsedDiff   - Parsed diff for the file (from parsePatchFiles or parseDiff)
 * @param fileContent  - Optional full new-file content for fallback scan
 * @returns Resolved line numbers or Unresolved
 */
export function resolveLines(
	existingCode: string,
	parsedDiff: ParsedDiff,
	fileContent?: string,
): LinesResult {
	if (!existingCode || !parsedDiff || parsedDiff.lines.length === 0) {
		return { unresolved: true };
	}

	const targetLines = splitAndNormalize(existingCode);
	if (targetLines.length === 0) {
		return { unresolved: true };
	}

	const hunks = reconstructHunks(parsedDiff);
	if (hunks.length === 0) {
		return { unresolved: true };
	}

	// Tier 1: New-side match (context + added → new-file line numbers)
	for (const hunk of hunks) {
		const result = matchConsecutive(hunk.newSide, targetLines);
		if (result) return result;
	}

	// Tier 2: Old-side match (context + deleted → old-file line numbers)
	for (const hunk of hunks) {
		const result = matchConsecutive(hunk.oldSide, targetLines);
		if (result) return result;
	}

	// Tier 3: File-content fallback
	if (fileContent) {
		const result = matchInFileContent(fileContent, targetLines);
		if (result) return result;
	}

	return { unresolved: true };
}

/**
 * Convenience wrapper: resolve from a raw unified diff string instead of
 * a pre-parsed ParsedDiff. Parses the diff internally.
 *
 * @param existingCode - The code snippet from the LLM comment
 * @param unifiedDiff  - Raw unified diff text (single file)
 * @param fileContent  - Optional full new-file content for fallback scan
 */
export function resolveLinesFromPatch(
	existingCode: string,
	unifiedDiff: string,
	fileContent?: string,
): LinesResult {
	const parsed = parsePatchFiles(unifiedDiff);
	if (parsed.length === 0) return { unresolved: true };
	// For multi-file patches, try each file's diff
	for (const pd of parsed) {
		const result = resolveLines(existingCode, pd, fileContent);
		if (!("unresolved" in result)) return result;
	}
	return { unresolved: true };
}
