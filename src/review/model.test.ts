import { describe, expect, it } from "vitest";

import type { ReviewDiff } from "./git.js";
import {
	buildViewportLines,
	getSelectedPreviewLine,
	getViewportState,
	moveSelectedPreviewLine,
	selectPreviewLineForComment,
	syncPreviewSelection,
} from "./model.js";
import { createDraftComment, createReviewDiffSession, syncReviewDiffSession } from "./session.js";

const DIFF: ReviewDiff = {
	mode: { type: "working-tree" },
	raw: "",
	files: [
		{
			oldPath: "src/a.ts",
			newPath: "src/a.ts",
			path: "src/a.ts",
			status: "modified",
			hunks: [
				{
					id: "src/a.ts:1:1",
					oldStart: 1,
					oldLines: 2,
					newStart: 1,
					newLines: 3,
					header: "@@ -1,2 +1,3 @@",
					lines: [
						{ type: "ctx", oldNum: 1, newNum: 1, content: "export const a = 1;" },
						{ type: "del", oldNum: 2, newNum: null, content: "return a;" },
						{ type: "add", oldNum: null, newNum: 2, content: "const next = a + 1;" },
						{ type: "add", oldNum: null, newNum: 3, content: "return next;" },
					],
				},
			],
		},
	],
};

describe("review model helpers", () => {
	it("builds hunk viewport lines and syncs preview selection to the first selectable diff line", () => {
		const session = syncReviewDiffSession(createReviewDiffSession(DIFF.mode), DIFF);
		syncPreviewSelection(session, DIFF);
		const lines = buildViewportLines(DIFF.files[0] ?? null, session.comments, session.selectedHunk);
		expect(lines[0]?.kind).toBe("hunk-header");
		expect(getSelectedPreviewLine(DIFF, session)?.content).toBe("export const a = 1;");
		expect(session.previewScrollTop).toBe(0);
	});

	it("moves cursor and scroll together: delta 2 advances selectedPreviewLineId by 2 selectable lines", () => {
		const session = syncReviewDiffSession(createReviewDiffSession(DIFF.mode), DIFF);
		syncPreviewSelection(session, DIFF);
		// Cursor starts at first selectable (ctx, index 1). Delta=2, windowSize=3.
		// selectableLines = [ctx:1, del:2, add:2, add:3]; after delta=2 → add:2 "const next = a + 1;" (index 3)
		moveSelectedPreviewLine(session, DIFF, 2, 3);
		expect(session.previewScrollTop).toBe(2); // clamp(max(0,3-1)=2, 5, 3) = 2
		expect(getSelectedPreviewLine(DIFF, session)?.content).toBe("const next = a + 1;");

		const selectedLine = buildViewportLines(DIFF.files[0] ?? null, session.comments, session.selectedHunk)[3];
		const comment = createDraftComment({
			session,
			file: "src/a.ts",
			line: selectedLine?.newNum ?? undefined,
			hunkId: selectedLine?.hunkId,
			previewLineId: selectedLine?.id,
			newNum: selectedLine?.newNum,
			oldNum: selectedLine?.oldNum,
			lineType: selectedLine?.kind === "hunk-header" ? undefined : selectedLine?.kind,
			body: "Anchor this exact line.",
		});
		session.comments.push(comment);
		session.selectedCommentId = comment.id;
		session.selectedPreviewLineId = undefined;

		selectPreviewLineForComment(session, DIFF);
		expect(getSelectedPreviewLine(DIFF, session)?.id).toBe(comment.previewLineId);
		expect(session.previewScrollTop).toBe(0);
	});

	it("returns a scroll window over the selected hunk instead of a centered file-wide line window", () => {
		const session = syncReviewDiffSession(createReviewDiffSession(DIFF.mode), DIFF);
		syncPreviewSelection(session, DIFF);
		moveSelectedPreviewLine(session, DIFF, 2, 3);
		const viewport = getViewportState(DIFF, session, 3);
		expect(viewport.visibleLines).toHaveLength(3);
		expect(viewport.windowStart).toBe(2);
		expect(viewport.visibleLines[0]?.content).toBe("return a;");
		expect(viewport.lines).toHaveLength(5);
	});
});
