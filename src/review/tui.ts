import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

import { renderReviewFilePreview } from "./file-preview.js";
import { countReviewDiffLines, countReviewFileLines, countReviewHunkLines, type ReviewDiff } from "./git.js";
import {
	getViewportState,
	moveSelectedPreviewLine,
	selectPreviewLineForComment,
	selectPreviewLineForHunk,
	syncPreviewSelection,
} from "./model.js";
import {
	getSelectedComment,
	moveSelectedComment,
	moveSelectedFile,
	moveSelectedHunk,
	type ReviewDiffSession,
	type ReviewDraftComment,
	toggleSelectedCommentStatus,
} from "./session.js";

export type ReviewDiffPaneAction =
	| { type: "cancel" }
	| { type: "refresh" }
	| { type: "add-comment" }
	| { type: "edit-comment" }
	| { type: "open-location" }
	| { type: "copy-location" }
	| { type: "delete-comment" }
	| { type: "approve-all" }
	| { type: "submit" };

const FILE_WINDOW_SIZE = 12;
const HUNK_WINDOW_SIZE = 8;
const COMMENT_WINDOW_SIZE = 10;
const PREVIEW_WINDOW_SIZE = 18;
const FILE_DIFF_VIEWPORT_HEIGHT = 20;
const MOUSE_WHEEL_LINES = 3;
const MIN_PANE_WIDTH = 40;
const OVERLAY_WIDTH_SAFETY_MARGIN = 3;
const TAB_WIDTH = 4;

interface ReviewDiffPaneOptions {
	requestRender?: () => void;
	renderFilePreview?: typeof renderReviewFilePreview;
}

export class ReviewDiffPane {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private focus: "files" | "hunks" | "preview" | "comments" = "files";
	private previewKey?: string;
	private previewLines?: string[];
	private previewPending = false;
	private previewRenderCache = new Map<string, string[]>();
	private readonly requestRender?: () => void;
	private readonly renderFilePreview: typeof renderReviewFilePreview;

	constructor(
		private diff: ReviewDiff,
		private session: ReviewDiffSession,
		private theme: Theme,
		private onDone: (action: ReviewDiffPaneAction) => void,
		options: ReviewDiffPaneOptions = {},
	) {
		this.requestRender = options.requestRender;
		this.renderFilePreview = options.renderFilePreview ?? renderReviewFilePreview;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone({ type: "cancel" });
			return;
		}
		if (data === "r") {
			this.onDone({ type: "refresh" });
			return;
		}
		if (data === "c") {
			this.onDone({ type: "add-comment" });
			return;
		}
		if (data === "x") {
			this.onDone({ type: "delete-comment" });
			return;
		}
		if (data === "o") {
			this.onDone({ type: "open-location" });
			return;
		}
		if (data === "y") {
			this.onDone({ type: "copy-location" });
			return;
		}
		if (data === "A") {
			this.onDone({ type: "approve-all" });
			return;
		}
		if (data === "s" || matchesKey(data, Key.ctrl("s"))) {
			this.onDone({ type: "submit" });
			return;
		}
		if (data === "e") {
			this.onDone({ type: "edit-comment" });
			return;
		}
		if (matchesKey(data, Key.enter) && this.focus === "comments") {
			this.onDone({ type: "edit-comment" });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.focus =
				this.focus === "files"
					? "hunks"
					: this.focus === "hunks"
						? "preview"
						: this.focus === "preview"
							? "comments"
							: "files";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.focus =
				this.focus === "files"
					? "comments"
					: this.focus === "hunks"
						? "files"
						: this.focus === "preview"
							? "hunks"
							: "preview";
			this.invalidate();
			return;
		}
		const wheelDelta = mouseWheelDelta(data);
		if (wheelDelta !== 0) {
			this.focus = "preview";
			this.move(wheelDelta * MOUSE_WHEEL_LINES);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.movePage(-1);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.movePage(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.moveToBoundary("start");
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveToBoundary("end");
			return;
		}
		if (matchesKey(data, Key.left) || data === "[") {
			this.focus = "files";
			moveSelectedFile(this.session, this.diff, -1);
			syncPreviewSelection(this.session, this.diff);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.right) || data === "]") {
			this.focus = "files";
			moveSelectedFile(this.session, this.diff, 1);
			syncPreviewSelection(this.session, this.diff);
			this.invalidate();
			return;
		}
		if (data === "a" && this.focus === "comments") {
			toggleSelectedCommentStatus(this.session, "approved");
			selectPreviewLineForComment(this.session, this.diff);
			this.invalidate();
			return;
		}
		if (data === "d" && this.focus === "comments") {
			toggleSelectedCommentStatus(this.session, "dismissed");
			selectPreviewLineForComment(this.session, this.diff);
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		syncPreviewSelection(this.session, this.diff);
		const th = this.theme;
		const maxW = clampPaneWidth(width);
		const innerW = Math.max(20, maxW - 2);
		const lines: string[] = [];
		const viewport = getViewportState(this.diff, this.session, PREVIEW_WINDOW_SIZE);
		const selectedComment = getSelectedComment(this.session);
		const diffCounts = countReviewDiffLines(this.diff);
		const fileWindow = visibleWindow(
			this.diff.files,
			indexOfSelectedFile(this.diff.files, viewport.file?.path),
			FILE_WINDOW_SIZE,
		);
		const hunkWindow = visibleWindow(
			viewport.file?.hunks ?? [],
			indexOfSelectedHunk(viewport.file?.hunks ?? [], viewport.hunk?.id),
			HUNK_WINDOW_SIZE,
		);
		const commentWindow = visibleWindow(
			this.session.comments,
			indexOfSelectedComment(this.session.comments, selectedComment?.id),
			COMMENT_WINDOW_SIZE,
		);

		const row = (content = "") => {
			const normalized = expandTabs(content);
			const fitted = clampToWidth(normalized, innerW);
			const padding = Math.max(0, innerW - visibleWidth(fitted));
			const fullLine = th.fg("border", "│") + fitted + " ".repeat(padding) + th.fg("border", "│");
			lines.push(clampToWidth(fullLine, maxW));
		};

		const addWrapped = (content: string, prefix = "") => {
			const normalizedPrefix = expandTabs(prefix);
			const available = Math.max(8, innerW - visibleWidth(normalizedPrefix));
			const normalizedContent = expandTabs(content, visibleWidth(normalizedPrefix));
			for (const part of wrapTextWithAnsi(normalizedContent, available)) {
				row(normalizedPrefix + part);
			}
		};

		const divider = () => row(th.fg("dim", "─".repeat(innerW)));
		lines.push(clampToWidth(th.fg("border", `╭${"─".repeat(innerW)}╮`), maxW));
		row(
			th.fg("accent", th.bold(" Review Diff ")) +
				th.fg("muted", ` ${this.diff.mode.type === "branch" ? `${this.diff.mode.base}...HEAD` : "working tree"}`) +
				th.fg("dim", " │ ") +
				th.fg("accent", `${this.diff.files.length} files`) +
				th.fg("dim", " │ ") +
				th.fg("success", `+${diffCounts.insertions}`) +
				th.fg("dim", " ") +
				th.fg("error", `-${diffCounts.deletions}`),
		);
		divider();
		row("");
		addWrapped(this.focusHeader("files", `Files (${this.diff.files.length})`), "  ");
		if (fileWindow.start > 0) addWrapped(th.fg("muted", `… ${fileWindow.start} earlier files`), "    ");
		for (const file of fileWindow.items) {
			const marker = viewport.file?.path === file.path ? "▶" : " ";
			const fileCounts = countReviewFileLines(file);
			addWrapped(
				this.styleForFocus(
					"files",
					viewport.file?.path === file.path
						? th.fg(
								"accent",
								`${marker} ${file.path} (${file.status}, +${fileCounts.insertions}/-${fileCounts.deletions}, ${file.hunks.length} hunks)`,
							)
						: `${marker} ${file.path} (${file.status}, +${fileCounts.insertions}/-${fileCounts.deletions}, ${file.hunks.length} hunks)`,
				),
				"    ",
			);
		}
		if (fileWindow.end < fileWindow.total)
			addWrapped(th.fg("muted", `… ${fileWindow.total - fileWindow.end} more files`), "    ");
		row("");
		addWrapped(this.focusHeader("hunks", `Hunks${viewport.file ? ` for ${viewport.file.path}` : ""}`), "  ");
		if (!viewport.file || viewport.file.hunks.length === 0) {
			addWrapped(th.fg("muted", "No hunks available."), "    ");
		} else {
			if (hunkWindow.start > 0) addWrapped(th.fg("muted", `… ${hunkWindow.start} earlier hunks`), "    ");
			for (const hunk of hunkWindow.items) {
				const marker = viewport.hunk?.id === hunk.id ? "▶" : " ";
				const hunkCounts = countReviewHunkLines(hunk);
				addWrapped(
					this.styleForFocus(
						"hunks",
						viewport.hunk?.id === hunk.id
							? th.fg(
									"accent",
									`${marker} ${hunk.id} (+${hunkCounts.insertions}/-${hunkCounts.deletions}) ${hunk.header}`,
								)
							: `${marker} ${hunk.id} (+${hunkCounts.insertions}/-${hunkCounts.deletions}) ${hunk.header}`,
					),
					"    ",
				);
			}
			if (hunkWindow.end < hunkWindow.total)
				addWrapped(th.fg("muted", `… ${hunkWindow.total - hunkWindow.end} more hunks`), "    ");
		}
		row("");
		addWrapped(this.focusHeader("preview", `File diff${viewport.file ? ` for ${viewport.file.path}` : ""}`), "  ");
		if (viewport.file) {
			const visibleStart = viewport.lines.length === 0 ? 0 : viewport.windowStart + 1;
			const visibleEnd = Math.min(viewport.windowEnd, viewport.lines.length);
			const scrollStatus = `${visibleStart}-${visibleEnd}/${viewport.lines.length}`;
			addWrapped(
				th.fg(
					"muted",
					`Fixed ${FILE_DIFF_VIEWPORT_HEIGHT}-line hunk viewport • ${scrollStatus} • mouse wheel/↑↓/pgup/pgdn/home/end scroll`,
				),
				"    ",
			);
			this.ensurePreview({
				filePath: viewport.file.path,
				lines: viewport.lines,
				theme: th,
				width: Math.max(20, innerW - 4),
			});
			this.renderFixedPreviewRows(
				row,
				th,
				viewport.windowStart,
				viewport.windowEnd,
				viewport.lines.length,
				viewport.visibleLines,
				viewport.selectedLine?.id,
			);
		} else {
			addWrapped(th.fg("muted", "No selected file diff."), "    ");
		}
		row("");
		addWrapped(this.focusHeader("comments", `Comments (${this.session.comments.length})`), "  ");
		if (this.session.comments.length === 0) {
			addWrapped(
				th.fg("muted", "No drafted comments yet. Press c to draft one on the selected preview line or hunk."),
				"    ",
			);
		} else {
			if (commentWindow.start > 0) addWrapped(th.fg("muted", `… ${commentWindow.start} earlier comments`), "    ");
			for (const comment of commentWindow.items) {
				const marker = selectedComment?.id === comment.id ? "▶" : " ";
				const status =
					comment.status === "dismissed"
						? th.fg("error", "dismissed")
						: comment.status === "edited"
							? th.fg("warning", "edited")
							: th.fg("success", "approved");
				const location = comment.previewLineId
					? `${comment.file}${comment.newNum ? `:${comment.newNum}` : comment.oldNum ? `:${comment.oldNum}` : ""}`
					: `${comment.file}${comment.line ? `:${comment.line}` : ""}`;
				addWrapped(this.styleForFocus("comments", `${marker} ${comment.id} ${location} [${status}]`), "    ");
				addWrapped(th.fg("text", comment.body), "      ");
			}
			if (commentWindow.end < commentWindow.total)
				addWrapped(th.fg("muted", `… ${commentWindow.total - commentWindow.end} more comments`), "    ");
		}
		row("");
		divider();
		row("");
		addWrapped(
			th.fg(
				"muted",
				"tab cycle focus • ↑↓/^j^k move • pgup/pgdn page • home/end jump • [/] prev/next file • o open location • y copy location",
			),
			"  ",
		);
		addWrapped(
			th.fg(
				"muted",
				"c draft comment • e edit comment • x delete • a approve • d dismiss • A approve all • r refresh • s submit to Pi • esc/q close",
			),
			"  ",
		);
		lines.push(clampToWidth(th.fg("border", `╰${"─".repeat(innerW)}╯`), maxW));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	updateReviewState(diff: ReviewDiff, session: ReviewDiffSession): void {
		this.diff = diff;
		this.session = session;
		this.previewKey = undefined;
		this.previewLines = undefined;
		this.previewPending = false;
		this.previewRenderCache.clear();
		this.invalidate();
	}

	private ensurePreview(input: Parameters<typeof renderReviewFilePreview>[0]): void {
		const nextKey = `${input.filePath}:${input.width}:${input.lines.map((line) => `${line.id}:${line.commentCount}`).join("|")}`;
		if (this.previewKey === nextKey) return;
		this.previewKey = nextKey;
		const cached = this.previewRenderCache.get(nextKey);
		if (cached) {
			this.previewLines = cached;
			this.previewPending = false;
			return;
		}
		// Keep the previous rendered hunk viewport visible while the next scroll frame is highlighted.
		// This avoids the File diff flashing back to "rendering diff…" while scrolling the selected hunk.
		if (!this.previewLines) this.previewLines = undefined;
		this.previewPending = true;
		this.renderFilePreview(input)
			.then((preview) => {
				this.previewRenderCache.set(nextKey, preview);
				while (this.previewRenderCache.size > 48) {
					const first = this.previewRenderCache.keys().next().value;
					if (first === undefined) break;
					this.previewRenderCache.delete(first);
				}
				if (this.previewKey !== nextKey) return;
				this.previewLines = preview;
				this.previewPending = false;
				this.invalidate();
				this.requestRender?.();
			})
			.catch(() => {
				if (this.previewKey !== nextKey) return;
				this.previewLines = undefined;
				this.previewPending = false;
				this.invalidate();
				this.requestRender?.();
			});
	}

	private renderFixedPreviewRows(
		row: (content?: string) => void,
		theme: Theme,
		windowStart: number,
		windowEnd: number,
		_totalLines: number,
		visibleLines: { id: string; isSelectable: boolean }[],
		selectedLineId?: string,
	): void {
		const rows = this.previewLines?.length
			? this.applyPreviewSelection(theme, this.previewLines.slice(windowStart, windowEnd), visibleLines, selectedLineId)
			: this.previewPending
				? [theme.fg("muted", "rendering diff…")]
				: [theme.fg("dim", "No preview lines in this viewport.")];

		for (let index = 0; index < FILE_DIFF_VIEWPORT_HEIGHT; index += 1) {
			row(`    ${rows[index] ?? ""}`);
		}
	}

	private applyPreviewSelection(
		theme: Theme,
		previewLines: string[],
		visibleLines: { id: string; isSelectable: boolean }[],
		selectedLineId?: string,
	): string[] {
		return previewLines.map((line, index) => {
			const viewportLine = visibleLines[index];
			if (!viewportLine?.isSelectable || viewportLine.id !== selectedLineId || line.length === 0) return line;
			return line.startsWith(" ") ? `${theme.fg("accent", "▶")}${line.slice(1)}` : `${theme.fg("accent", "▶")}${line}`;
		});
	}

	private move(delta: number): void {
		if (this.focus === "files") {
			moveSelectedFile(this.session, this.diff, delta);
			syncPreviewSelection(this.session, this.diff);
		} else if (this.focus === "hunks") {
			moveSelectedHunk(this.session, this.diff, delta);
			selectPreviewLineForHunk(this.session, this.diff, this.session.selectedHunk);
		} else if (this.focus === "preview") {
			moveSelectedPreviewLine(this.session, this.diff, delta);
		} else {
			moveSelectedComment(this.session, delta);
			selectPreviewLineForComment(this.session, this.diff);
		}
		this.invalidate();
	}

	private movePage(direction: -1 | 1): void {
		const distance =
			this.focus === "files"
				? FILE_WINDOW_SIZE - 1
				: this.focus === "hunks"
					? HUNK_WINDOW_SIZE - 1
					: this.focus === "preview"
						? FILE_DIFF_VIEWPORT_HEIGHT - 1
						: COMMENT_WINDOW_SIZE - 1;
		this.move(direction * Math.max(1, distance));
	}

	private moveToBoundary(edge: "start" | "end"): void {
		const delta = edge === "start" ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
		this.move(delta);
	}

	private focusHeader(area: "files" | "hunks" | "preview" | "comments", label: string): string {
		return this.focus === area ? this.theme.fg("accent", this.theme.bold(label)) : this.theme.fg("muted", label);
	}

	private styleForFocus(area: "files" | "hunks" | "preview" | "comments", text: string): string {
		return this.focus === area ? this.theme.fg("text", text) : this.theme.fg("muted", text);
	}
}

function visibleWindow<T>(
	items: T[],
	selectedIndex: number,
	limit: number,
): { items: T[]; start: number; end: number; total: number } {
	if (items.length <= limit) return { items, start: 0, end: items.length, total: items.length };
	const clampedIndex = clampIndex(selectedIndex, items.length);
	const maxStart = items.length - limit;
	let start = Math.min(Math.max(clampedIndex - Math.floor(limit / 2), 0), maxStart);
	let end = start + limit;
	if (clampedIndex >= end) {
		start = Math.min(clampedIndex - limit + 1, maxStart);
		end = start + limit;
	}
	return { items: items.slice(start, end), start, end, total: items.length };
}

function indexOfSelectedFile(files: ReviewDiff["files"], selectedPath?: string): number {
	if (!selectedPath) return 0;
	const index = files.findIndex((file) => file.path === selectedPath || file.oldPath === selectedPath);
	return index < 0 ? 0 : index;
}

function indexOfSelectedHunk(hunks: NonNullable<ReviewDiff["files"][number]["hunks"]>, selectedId?: string): number {
	if (!selectedId) return 0;
	const index = hunks.findIndex((hunk) => hunk.id === selectedId);
	return index < 0 ? 0 : index;
}

function indexOfSelectedComment(comments: ReviewDraftComment[], selectedId?: string): number {
	if (!selectedId) return 0;
	const index = comments.findIndex((comment) => comment.id === selectedId);
	return index < 0 ? 0 : index;
}

function clampIndex(index: number, length: number): number {
	return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function clampPaneWidth(width: number): number {
	return Math.max(MIN_PANE_WIDTH, width - OVERLAY_WIDTH_SAFETY_MARGIN);
}

function clampToWidth(content: string, width: number): string {
	return visibleWidth(content) > width ? truncateToWidth(content, width) : content;
}

function expandTabs(content: string, startColumn = 0): string {
	let result = "";
	let column = startColumn;
	let index = 0;
	while (index < content.length) {
		const char = content[index];
		if (char === "\u001b") {
			const escapeEnd = findAnsiSequenceEnd(content, index);
			result += content.slice(index, escapeEnd);
			index = escapeEnd;
			continue;
		}
		if (char === "\t") {
			const spaces = TAB_WIDTH - (column % TAB_WIDTH || 0);
			result += " ".repeat(spaces);
			column += spaces;
			index += 1;
			continue;
		}
		result += char;
		column += visibleWidth(char);
		index += 1;
	}
	return result;
}

function findAnsiSequenceEnd(content: string, start: number): number {
	let index = start + 1;
	// Skip the '[' CSI introducer so we look for the actual final byte, not just '[' itself.
	// Without this, expandTabs leaks the parameter bytes (e.g. "48;2;22;38;32m") as visible text.
	if (index < content.length && content[index] === "[") index += 1;
	while (index < content.length) {
		const charCode = content.charCodeAt(index);
		if (charCode >= 0x40 && charCode <= 0x7e) return index + 1;
		index += 1;
	}
	return content.length;
}

function mouseWheelDelta(data: string): number {
	if (data === "mouseWheelUp" || data === "wheelUp" || data === "scrollUp") return -1;
	if (data === "mouseWheelDown" || data === "wheelDown" || data === "scrollDown") return 1;
	if (data.includes("[<64;")) return -1;
	if (data.includes("[<65;")) return 1;
	return 0;
}
