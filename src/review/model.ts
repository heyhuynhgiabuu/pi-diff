import type { ReviewDiff, ReviewFileDiff, ReviewHunk, ReviewLine } from "./git.js";
import type { ReviewDiffSession, ReviewDraftComment } from "./session.js";

export interface ReviewViewportLine {
	id: string;
	filePath: string;
	hunkId: string;
	kind: "hunk-header" | ReviewLine["type"];
	oldNum: number | null;
	newNum: number | null;
	content: string;
	commentCount: number;
	isSelectable: boolean;
}

export interface ReviewViewportState {
	file: ReviewFileDiff | null;
	hunk: ReviewHunk | null;
	lines: ReviewViewportLine[];
	selectedLine: ReviewViewportLine | null;
	visibleLines: ReviewViewportLine[];
	selectedLineIndex: number;
	windowStart: number;
	windowEnd: number;
}

const DEFAULT_VIEWPORT_WINDOW = 18;

export function createPreviewLineId(filePath: string, hunkId: string, line: ReviewLine, lineIndex: number): string {
	return `${filePath}:${hunkId}:${line.type}:${line.oldNum ?? "_"}:${line.newNum ?? "_"}:${lineIndex}`;
}

export function createHeaderLineId(filePath: string, hunkId: string): string {
	return `${filePath}:${hunkId}:header`;
}

export function buildViewportLines(
	file: ReviewFileDiff | null,
	comments: ReviewDraftComment[],
	hunkId?: string,
): ReviewViewportLine[] {
	if (!file) return [];
	const hunks = hunkId ? file.hunks.filter((hunk) => hunk.id === hunkId) : file.hunks;
	const lines: ReviewViewportLine[] = [];
	for (const hunk of hunks) {
		lines.push({
			id: createHeaderLineId(file.path, hunk.id),
			filePath: file.path,
			hunkId: hunk.id,
			kind: "hunk-header",
			oldNum: hunk.oldStart,
			newNum: hunk.newStart,
			content: hunk.header,
			commentCount: comments.filter((comment) => comment.hunkId === hunk.id && !comment.previewLineId).length,
			isSelectable: false,
		});
		hunk.lines.forEach((line, index) => {
			const id = createPreviewLineId(file.path, hunk.id, line, index);
			lines.push({
				id,
				filePath: file.path,
				hunkId: hunk.id,
				kind: line.type,
				oldNum: line.oldNum,
				newNum: line.newNum,
				content: line.content,
				commentCount: comments.filter((comment) => comment.previewLineId === id).length,
				isSelectable: true,
			});
		});
	}
	return lines;
}

export function getSelectedPreviewLine(diff: ReviewDiff, session: ReviewDiffSession): ReviewViewportLine | null {
	const file = getSelectedFile(diff, session);
	const hunk = getSelectedHunk(diff, session);
	if (!file || !hunk) return null;
	const lines = buildViewportLines(file, session.comments, hunk.id);
	if (lines.length === 0) return null;
	if (session.selectedPreviewLineId) {
		const selected = lines.find((line) => line.id === session.selectedPreviewLineId);
		if (selected) return selected;
	}
	const scrollIndex = clampIndex(session.previewScrollTop ?? 0, lines.length);
	const scrolledLine = lines[scrollIndex];
	if (scrolledLine?.isSelectable) return scrolledLine;
	return firstSelectableLine(lines) ?? scrolledLine ?? null;
}

export function syncPreviewSelection(session: ReviewDiffSession, diff: ReviewDiff): void {
	const file = getSelectedFile(diff, session);
	const hunk = getSelectedHunk(diff, session);
	if (!file || !hunk) {
		session.selectedPreviewLineId = undefined;
		session.previewScrollTop = 0;
		return;
	}
	const lines = buildViewportLines(file, session.comments, hunk.id);
	if (lines.length === 0) {
		session.selectedPreviewLineId = undefined;
		session.previewScrollTop = 0;
		return;
	}
	const selected = session.selectedPreviewLineId
		? lines.find((line) => line.id === session.selectedPreviewLineId && line.isSelectable)
		: null;
	if (!selected) {
		session.selectedPreviewLineId = firstSelectableLine(lines)?.id;
	}
	clampPreviewScroll(session, lines.length, DEFAULT_VIEWPORT_WINDOW);
}

export function moveSelectedPreviewLine(
	session: ReviewDiffSession,
	diff: ReviewDiff,
	delta: number,
	windowSize = DEFAULT_VIEWPORT_WINDOW,
): void {
	const file = getSelectedFile(diff, session);
	const hunk = getSelectedHunk(diff, session);
	if (!file || !hunk) {
		session.previewScrollTop = 0;
		return;
	}
	const lines = buildViewportLines(file, session.comments, hunk.id);
	if (lines.length === 0) {
		session.previewScrollTop = 0;
		return;
	}
	const selectableLines = lines.filter((l) => l.isSelectable);
	if (selectableLines.length === 0) return;
	const currentPos = session.selectedPreviewLineId
		? Math.max(
				0,
				selectableLines.findIndex((l) => l.id === session.selectedPreviewLineId),
			)
		: 0;
	const newPos = clampIndex(currentPos + delta, selectableLines.length);
	const newLine = selectableLines[newPos];
	session.selectedPreviewLineId = newLine?.id;
	const cursorIndex = lines.findIndex((l) => l.id === newLine?.id);
	session.previewScrollTop =
		cursorIndex >= 0 ? clampScrollTop(Math.max(0, cursorIndex - 1), lines.length, windowSize) : 0;
}

export function selectPreviewLineForHunk(session: ReviewDiffSession, diff: ReviewDiff, hunkId?: string): void {
	const file = getSelectedFile(diff, session);
	if (!file) {
		session.selectedPreviewLineId = undefined;
		session.previewScrollTop = 0;
		return;
	}
	const lines = buildViewportLines(file, session.comments, hunkId);
	const selected = firstSelectableLine(lines, hunkId);
	session.selectedPreviewLineId = selected?.id;
	session.previewScrollTop = 0;
	if (selected?.hunkId) session.selectedHunk = selected.hunkId;
}

export function selectPreviewLineForComment(session: ReviewDiffSession, diff: ReviewDiff): void {
	const comment = getSelectedComment(session);
	if (!comment) return;
	const file = getSelectedFile(diff, session);
	if (!file || file.path !== comment.file) {
		session.selectedFile = comment.file;
	}
	if (comment.hunkId) session.selectedHunk = comment.hunkId;
	const nextFile = getSelectedFile(diff, session);
	const nextHunk = getSelectedHunk(diff, session);
	if (!nextFile || !nextHunk) return;
	const lines = buildViewportLines(nextFile, session.comments, nextHunk.id);
	if (comment.previewLineId) {
		session.selectedPreviewLineId = comment.previewLineId;
		const selectedIndex = lines.findIndex((line) => line.id === comment.previewLineId);
		session.previewScrollTop = clampScrollTop(Math.max(0, selectedIndex - 1), lines.length, DEFAULT_VIEWPORT_WINDOW);
		return;
	}
	syncPreviewSelection(session, diff);
}

export function getViewportState(
	diff: ReviewDiff,
	session: ReviewDiffSession,
	windowSize = DEFAULT_VIEWPORT_WINDOW,
): ReviewViewportState {
	const file = getSelectedFile(diff, session);
	const hunk = getSelectedHunk(diff, session);
	const lines = buildViewportLines(file, session.comments, hunk?.id);
	const selectedLine = getSelectedPreviewLine(diff, session);
	const selectedLineIndex = Math.max(
		0,
		lines.findIndex((line) => line.id === selectedLine?.id),
	);
	const windowStart = clampScrollTop(session.previewScrollTop ?? 0, lines.length, windowSize);
	const windowEnd = Math.min(lines.length, windowStart + windowSize);
	return {
		file,
		hunk,
		lines,
		selectedLine,
		visibleLines: lines.slice(windowStart, windowEnd),
		selectedLineIndex,
		windowStart,
		windowEnd,
	};
}

function clampPreviewScroll(session: ReviewDiffSession, lineCount: number, windowSize: number): void {
	session.previewScrollTop = clampScrollTop(session.previewScrollTop ?? 0, lineCount, windowSize);
}

function clampScrollTop(scrollTop: number, lineCount: number, windowSize: number): number {
	if (lineCount <= 0) return 0;
	const maxScrollTop = Math.max(0, lineCount - Math.max(1, windowSize));
	return Math.max(0, Math.min(scrollTop, maxScrollTop));
}

function firstSelectableLine(lines: ReviewViewportLine[], hunkId?: string): ReviewViewportLine | null {
	return lines.find((line) => line.isSelectable && (!hunkId || line.hunkId === hunkId)) ?? null;
}

function clampIndex(index: number, length: number): number {
	return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function getSelectedFile(diff: ReviewDiff, session: ReviewDiffSession): ReviewFileDiff | null {
	if (!session.selectedFile) return diff.files[0] ?? null;
	return diff.files.find((file) => file.path === session.selectedFile || file.oldPath === session.selectedFile) ?? null;
}

function getSelectedHunk(diff: ReviewDiff, session: ReviewDiffSession): ReviewHunk | null {
	const file = getSelectedFile(diff, session);
	if (!file) return null;
	if (!session.selectedHunk) return file.hunks[0] ?? null;
	return file.hunks.find((hunk) => hunk.id === session.selectedHunk) ?? file.hunks[0] ?? null;
}

function getSelectedComment(session: ReviewDiffSession): ReviewDraftComment | null {
	if (!session.selectedCommentId) return null;
	return session.comments.find((comment) => comment.id === session.selectedCommentId) ?? null;
}
