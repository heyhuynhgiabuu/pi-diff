import type { ReviewDiff, ReviewDiffMode, ReviewFileDiff, ReviewHunk, ReviewLine } from "./git.js";

export interface ReviewExportOptions {
	includeRawDiff?: boolean;
	maxLinesPerHunk?: number;
}

export function formatReviewMarkdown(diff: ReviewDiff, options: ReviewExportOptions = {}): string {
	const maxLinesPerHunk = options.maxLinesPerHunk ?? 80;
	const lines: string[] = [];
	lines.push("# Code Review Context");
	lines.push("");
	lines.push(`Mode: ${formatMode(diff.mode)}`);
	lines.push(`Files changed: ${diff.files.length}`);
	lines.push("");

	if (diff.files.length === 0) {
		lines.push("No changes found.");
		return lines.join("\n");
	}

	lines.push("## Review instructions for an agent");
	lines.push("");
	lines.push(
		"Review the changed files below. Focus on correctness, regressions, security, missing tests, and maintainability. Cite file paths and changed line numbers. Do not comment on unchanged code unless it is necessary to explain a changed-line issue.",
	);
	lines.push("");
	lines.push("## Changed files");
	lines.push("");

	for (const file of diff.files) {
		lines.push(formatFileSummary(file));
	}
	lines.push("");

	for (const file of diff.files) {
		lines.push(`## ${file.path}`);
		lines.push("");
		lines.push(`Status: ${file.status}`);
		if (file.oldPath && file.oldPath !== file.path) lines.push(`Old path: ${file.oldPath}`);
		lines.push("");

		for (const hunk of file.hunks) {
			lines.push(formatHunk(file, hunk, maxLinesPerHunk));
			lines.push("");
		}
	}

	if (options.includeRawDiff && diff.raw.trim()) {
		lines.push("## Raw diff");
		lines.push("");
		lines.push("```diff");
		lines.push(diff.raw.trimEnd());
		lines.push("```");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function formatMode(mode: ReviewDiffMode): string {
	return mode.type === "branch" ? `branch (${mode.base}...HEAD)` : "working tree";
}

function formatFileSummary(file: ReviewFileDiff): string {
	const additions = countLines(file, "add");
	const deletions = countLines(file, "del");
	return `- ${file.path} (${file.status}, +${additions}/-${deletions}, ${file.hunks.length} hunks)`;
}

function countLines(file: ReviewFileDiff, type: ReviewLine["type"]): number {
	return file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.type === type).length, 0);
}

function formatHunk(file: ReviewFileDiff, hunk: ReviewHunk, maxLines: number): string {
	const lines: string[] = [];
	lines.push(`### ${file.path}:${hunk.newStart}`);
	lines.push("");
	lines.push("```diff");
	lines.push(hunk.header);
	const visible = hunk.lines.slice(0, maxLines);
	for (const line of visible) {
		const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
		const number = line.type === "del" ? line.oldNum : line.newNum;
		const gutter = number === null ? "" : String(number).padStart(4, " ");
		lines.push(`${marker}${gutter} ${line.content}`);
	}
	if (hunk.lines.length > visible.length) {
		lines.push(` … ${hunk.lines.length - visible.length} more changed/context lines omitted`);
	}
	lines.push("```");
	return lines.join("\n");
}
