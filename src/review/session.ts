import type { ReviewDiff, ReviewDiffMode, ReviewFileDiff, ReviewHunk } from "./git.js";

export const REVIEW_DIFF_SESSION_TYPE = "review-diff-session";

export type ReviewCommentStatus = "approved" | "dismissed" | "edited";

export interface ReviewDraftComment {
	id: string;
	file: string;
	line?: number;
	hunkId?: string;
	previewLineId?: string;
	oldNum?: number | null;
	newNum?: number | null;
	lineType?: ReviewHunk["lines"][number]["type"];
	body: string;
	createdAt: string;
	status: ReviewCommentStatus;
	originalBody?: string;
}

export interface ReviewDiffSession {
	mode: ReviewDiffMode;
	selectedFile?: string;
	selectedHunk?: string;
	selectedPreviewLineId?: string;
	previewScrollTop?: number;
	selectedCommentId?: string;
	comments: ReviewDraftComment[];
	updatedAt: number;
	submittedAt?: number;
}

export function createReviewDiffSession(mode: ReviewDiffMode): ReviewDiffSession {
	return {
		mode,
		comments: [],
		previewScrollTop: 0,
		updatedAt: Date.now(),
	};
}

export function cloneReviewDiffSession(session: ReviewDiffSession): ReviewDiffSession {
	return {
		...session,
		comments: session.comments.map((comment) => ({ ...comment })),
	};
}

export function getLatestReviewDiffSession(ctx: {
	sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> };
}): ReviewDiffSession | null {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: ReviewDiffSession };
		if (entry.type === "custom" && entry.customType === REVIEW_DIFF_SESSION_TYPE && entry.data?.mode) {
			return entry.data;
		}
	}
	return null;
}

export function persistReviewDiffSession(
	pi: { appendEntry(customType: string, data?: unknown): void },
	session: ReviewDiffSession,
): void {
	session.updatedAt = Date.now();
	pi.appendEntry(REVIEW_DIFF_SESSION_TYPE, session);
}

export function syncReviewDiffSession(session: ReviewDiffSession, diff: ReviewDiff): ReviewDiffSession {
	const next = cloneReviewDiffSession(session);
	const previousFile = next.selectedFile;
	const previousHunk = next.selectedHunk;
	const selectedFile = getSelectedFile(diff, next) ?? diff.files[0] ?? null;
	next.selectedFile = selectedFile?.path;
	const selectedHunk = selectedFile ? (getSelectedHunk(diff, next) ?? selectedFile.hunks[0] ?? null) : null;
	next.selectedHunk = selectedHunk?.id;
	if (next.selectedFile !== previousFile || next.selectedHunk !== previousHunk) {
		next.previewScrollTop = 0;
	}
	if (next.comments.length === 0) {
		next.selectedCommentId = undefined;
	} else if (!next.selectedCommentId || !next.comments.some((comment) => comment.id === next.selectedCommentId)) {
		next.selectedCommentId = next.comments[0]?.id;
	}
	return next;
}

export function getSelectedFile(diff: ReviewDiff, session: ReviewDiffSession): ReviewFileDiff | null {
	if (!session.selectedFile) return null;
	return diff.files.find((file) => file.path === session.selectedFile || file.oldPath === session.selectedFile) ?? null;
}

export function getSelectedHunk(diff: ReviewDiff, session: ReviewDiffSession): ReviewHunk | null {
	const file = getSelectedFile(diff, session);
	if (!file || !session.selectedHunk) return null;
	return file.hunks.find((hunk) => hunk.id === session.selectedHunk) ?? null;
}

export function getSelectedComment(session: ReviewDiffSession): ReviewDraftComment | null {
	if (!session.selectedCommentId) return null;
	return session.comments.find((comment) => comment.id === session.selectedCommentId) ?? null;
}

export function moveSelectedFile(session: ReviewDiffSession, diff: ReviewDiff, delta: number): void {
	if (diff.files.length === 0) {
		session.selectedFile = undefined;
		session.selectedHunk = undefined;
		session.previewScrollTop = 0;
		return;
	}
	const currentPath = getSelectedFile(diff, session)?.path;
	const currentIndex = Math.max(
		0,
		diff.files.findIndex((file) => file.path === currentPath),
	);
	const nextIndex = clampIndex(currentIndex + delta, diff.files.length);
	const file = diff.files[nextIndex];
	session.selectedFile = file?.path;
	session.selectedHunk = file?.hunks[0]?.id;
	session.selectedPreviewLineId = undefined;
	session.previewScrollTop = 0;
}

export function moveSelectedHunk(session: ReviewDiffSession, diff: ReviewDiff, delta: number): void {
	const file = getSelectedFile(diff, session);
	if (!file || file.hunks.length === 0) {
		session.selectedHunk = undefined;
		session.previewScrollTop = 0;
		return;
	}
	const currentId = getSelectedHunk(diff, session)?.id;
	const currentIndex = Math.max(
		0,
		file.hunks.findIndex((hunk) => hunk.id === currentId),
	);
	const nextIndex = clampIndex(currentIndex + delta, file.hunks.length);
	session.selectedHunk = file.hunks[nextIndex]?.id;
	session.selectedPreviewLineId = undefined;
	session.previewScrollTop = 0;
}

export function moveSelectedComment(session: ReviewDiffSession, delta: number): void {
	if (session.comments.length === 0) {
		session.selectedCommentId = undefined;
		return;
	}
	const currentIndex = Math.max(
		0,
		session.comments.findIndex((comment) => comment.id === session.selectedCommentId),
	);
	const nextIndex = clampIndex(currentIndex + delta, session.comments.length);
	session.selectedCommentId = session.comments[nextIndex]?.id;
}

export function createDraftComment(input: {
	session: ReviewDiffSession;
	file: string;
	body: string;
	line?: number;
	hunkId?: string;
	previewLineId?: string;
	oldNum?: number | null;
	newNum?: number | null;
	lineType?: ReviewHunk["lines"][number]["type"];
	now?: Date;
}): ReviewDraftComment {
	const next = input.session.comments.length + 1;
	return {
		id: `C${String(next).padStart(3, "0")}`,
		file: input.file,
		line: input.line,
		hunkId: input.hunkId,
		previewLineId: input.previewLineId,
		oldNum: input.oldNum,
		newNum: input.newNum,
		lineType: input.lineType,
		body: input.body,
		createdAt: (input.now ?? new Date()).toISOString(),
		status: "approved",
	};
}

export function addDraftComment(session: ReviewDiffSession, comment: ReviewDraftComment): void {
	session.comments.push(comment);
	session.selectedCommentId = comment.id;
}

export function editSelectedComment(session: ReviewDiffSession, body: string): ReviewDraftComment | null {
	const comment = getSelectedComment(session);
	if (!comment) return null;
	if (comment.body !== body) {
		comment.originalBody ??= comment.body;
		comment.body = body;
		comment.status = "edited";
	}
	return comment;
}

export function deleteSelectedComment(session: ReviewDiffSession): ReviewDraftComment | null {
	const currentIndex = session.comments.findIndex((comment) => comment.id === session.selectedCommentId);
	if (currentIndex < 0) return null;
	const [removed] = session.comments.splice(currentIndex, 1);
	session.selectedCommentId = session.comments[Math.min(currentIndex, session.comments.length - 1)]?.id;
	return removed ?? null;
}

export function toggleSelectedCommentStatus(
	session: ReviewDiffSession,
	status: Exclude<ReviewCommentStatus, "edited">,
): ReviewDraftComment | null {
	const comment = getSelectedComment(session);
	if (!comment) return null;
	comment.status = comment.status === status ? "approved" : status;
	return comment;
}

export function approveAllComments(session: ReviewDiffSession): void {
	for (const comment of session.comments) {
		comment.status = comment.status === "edited" ? "edited" : "approved";
	}
}

export function getSubmittableComments(session: ReviewDiffSession): ReviewDraftComment[] {
	return session.comments.filter((comment) => comment.status === "approved" || comment.status === "edited");
}

export function countCommentStatuses(session: ReviewDiffSession): Record<ReviewCommentStatus, number> {
	return {
		approved: session.comments.filter((comment) => comment.status === "approved").length,
		dismissed: session.comments.filter((comment) => comment.status === "dismissed").length,
		edited: session.comments.filter((comment) => comment.status === "edited").length,
	};
}

function clampIndex(index: number, length: number): number {
	return Math.max(0, Math.min(index, length - 1));
}
