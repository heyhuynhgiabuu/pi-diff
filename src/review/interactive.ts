import type { ReviewDiff, ReviewFileDiff, ReviewHunk, ReviewLine } from "./git.js";

export interface ReviewPanelOptions {
	file?: string;
	hunkId?: string;
	maxFiles?: number;
	maxHunks?: number;
	maxLinesPerHunk?: number;
}

export interface ReviewComment {
	id: string;
	file: string;
	line?: number;
	hunkId?: string;
	body: string;
	createdAt: string;
}

export function formatInteractiveReviewPanel(
	diff: ReviewDiff,
	comments: ReviewComment[] = [],
	options: ReviewPanelOptions = {},
): string {
	const maxFiles = options.maxFiles ?? 40;
	const maxHunks = options.maxHunks ?? 20;
	const maxLinesPerHunk = options.maxLinesPerHunk ?? 80;
	const selectedFile = options.file ? findFile(diff, options.file) : null;
	const selectedHunk = selectedFile && options.hunkId ? findHunk(selectedFile, options.hunkId) : null;
	const lines: string[] = [];

	lines.push("# Interactive Code Review");
	lines.push("");
	lines.push(`Mode: ${diff.mode.type === "branch" ? `${diff.mode.base}...HEAD` : "working tree"}`);
	lines.push(`Files changed: ${diff.files.length}`);
	lines.push(`Comments drafted: ${comments.length}`);
	lines.push("");
	lines.push("## Available actions");
	lines.push("");
	lines.push('- Focus a file: `review_git_diff({ file: "path/to/file.ts" })`');
	lines.push('- Focus a hunk: `review_git_diff({ file: "path/to/file.ts", hunkId: "path:old:new" })`');
	lines.push("Destructive actions such as revert/discard are intentionally not implemented yet.");
	lines.push("");

	lines.push("## Changed files");
	lines.push("");
	for (const file of diff.files.slice(0, maxFiles)) {
		const selected = selectedFile?.path === file.path ? "▶ " : "  ";
		lines.push(`${selected}${formatFileSummary(file)}`);
		for (const hunk of file.hunks.slice(0, 3)) {
			lines.push(`    - ${hunk.id} ${hunk.header}`);
		}
		if (file.hunks.length > 3) lines.push(`    - … ${file.hunks.length - 3} more hunks`);
	}
	if (diff.files.length > maxFiles) lines.push(`  … ${diff.files.length - maxFiles} more files`);
	lines.push("");

	if (selectedFile) {
		lines.push(formatFilePanel(selectedFile, comments, { ...options, maxHunks, maxLinesPerHunk }, selectedHunk));
	} else if (diff.files.length > 0) {
		lines.push("## Next step");
		lines.push("");
		lines.push('Pick a file from the changed-file list and call `review_git_diff({ file: "..." })` to inspect it.');
	} else {
		lines.push("No changes found.");
	}

	if (comments.length > 0) {
		lines.push("");
		lines.push(formatReviewComments(comments));
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

export function formatReviewComments(comments: ReviewComment[]): string {
	const lines: string[] = [];
	lines.push("## Drafted review comments");
	lines.push("");
	if (comments.length === 0) {
		lines.push("No drafted comments.");
		return lines.join("\n");
	}
	for (const comment of comments) {
		const loc = `${comment.file}${comment.line ? `:${comment.line}` : ""}${comment.hunkId ? ` (${comment.hunkId})` : ""}`;
		lines.push(`- ${comment.id} — ${loc}`);
		lines.push(`  ${comment.body}`);
	}
	return lines.join("\n");
}

export function createReviewComment(input: {
	comments: ReviewComment[];
	file: string;
	body: string;
	line?: number;
	hunkId?: string;
	now?: Date;
}): ReviewComment {
	const next = input.comments.length + 1;
	return {
		id: `C${String(next).padStart(3, "0")}`,
		file: input.file,
		line: input.line,
		hunkId: input.hunkId,
		body: input.body,
		createdAt: (input.now ?? new Date()).toISOString(),
	};
}

function formatFilePanel(
	file: ReviewFileDiff,
	comments: ReviewComment[],
	options: Required<Pick<ReviewPanelOptions, "maxHunks" | "maxLinesPerHunk">> & ReviewPanelOptions,
	selectedHunk: ReviewHunk | null,
): string {
	const lines: string[] = [];
	const hunks = selectedHunk ? [selectedHunk] : file.hunks.slice(0, options.maxHunks);
	lines.push(`## File: ${file.path}`);
	lines.push("");
	lines.push(`Status: ${file.status}`);
	if (file.oldPath && file.oldPath !== file.path) lines.push(`Old path: ${file.oldPath}`);
	lines.push(`Changes: +${countLines(file, "add")}/-${countLines(file, "del")}, ${file.hunks.length} hunks`);
	const fileComments = comments.filter((comment) => comment.file === file.path);
	if (fileComments.length > 0) lines.push(`Drafted comments on this file: ${fileComments.length}`);
	lines.push("");

	for (const hunk of hunks) {
		lines.push(formatHunk(file, hunk, options.maxLinesPerHunk));
		lines.push("");
	}
	if (!selectedHunk && file.hunks.length > hunks.length) {
		lines.push(`… ${file.hunks.length - hunks.length} more hunks. Focus by hunkId to inspect one hunk.`);
	}
	if (options.hunkId && !selectedHunk) {
		lines.push(`Hunk not found: ${options.hunkId}`);
	}
	return lines.join("\n").trimEnd();
}

function formatHunk(file: ReviewFileDiff, hunk: ReviewHunk, maxLines: number): string {
	const lines: string[] = [];
	lines.push(`### Hunk ${hunk.id}`);
	lines.push("");
	lines.push("```diff");
	lines.push(hunk.header);
	for (const line of hunk.lines.slice(0, maxLines)) {
		const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
		const number = line.type === "del" ? line.oldNum : line.newNum;
		const gutter = number === null ? "" : String(number).padStart(4, " ");
		lines.push(`${marker}${gutter} ${line.content}`);
	}
	if (hunk.lines.length > maxLines) lines.push(` … ${hunk.lines.length - maxLines} more lines omitted`);
	lines.push("```");
	lines.push("");
	lines.push(
		`File: ${file.path}, hunk: ${hunk.id}, first changed line: ${firstChangedLine(hunk) ?? hunk.newStart}`,
	);
	return lines.join("\n");
}

function formatFileSummary(file: ReviewFileDiff): string {
	return `${file.path} (${file.status}, +${countLines(file, "add")}/-${countLines(file, "del")}, ${file.hunks.length} hunks)`;
}

function countLines(file: ReviewFileDiff, type: ReviewLine["type"]): number {
	return file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.type === type).length, 0);
}

function firstChangedLine(hunk: ReviewHunk): number | null {
	const changed = hunk.lines.find((line) => line.type === "add" || line.type === "del");
	return changed?.newNum ?? changed?.oldNum ?? null;
}

function findFile(diff: ReviewDiff, path: string): ReviewFileDiff | null {
	return diff.files.find((file) => file.path === path || file.oldPath === path || file.newPath === path) ?? null;
}

function findHunk(file: ReviewFileDiff, hunkId: string): ReviewHunk | null {
	return (
		file.hunks.find((hunk) => hunk.id === hunkId || `${file.path}:${hunk.oldStart}:${hunk.newStart}` === hunkId) ?? null
	);
}
