import { describe, expect, it } from "vitest";

import type { ReviewDiff } from "./git.js";
import {
	addDraftComment,
	createDraftComment,
	createReviewDiffSession,
	deleteSelectedComment,
	editSelectedComment,
	getSubmittableComments,
	moveSelectedComment,
	moveSelectedFile,
	moveSelectedHunk,
	syncReviewDiffSession,
	toggleSelectedCommentStatus,
} from "./session.js";

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
					oldLines: 1,
					newStart: 1,
					newLines: 2,
					header: "@@ -1,1 +1,2 @@",
					lines: [
						{ type: "ctx", oldNum: 1, newNum: 1, content: "export const a = 1;" },
						{ type: "add", oldNum: null, newNum: 2, content: "export const b = 2;" },
					],
				},
			],
		},
		{
			oldPath: "src/b.ts",
			newPath: "src/b.ts",
			path: "src/b.ts",
			status: "modified",
			hunks: [
				{
					id: "src/b.ts:4:4",
					oldStart: 4,
					oldLines: 1,
					newStart: 4,
					newLines: 1,
					header: "@@ -4,1 +4,1 @@",
					lines: [{ type: "add", oldNum: null, newNum: 4, content: "return updated;" }],
				},
			],
		},
	],
};

describe("review session helpers", () => {
	it("syncs default selections and resets hunk preview scroll when navigating files and hunks", () => {
		const session = syncReviewDiffSession(createReviewDiffSession(DIFF.mode), DIFF);
		expect(session.selectedFile).toBe("src/a.ts");
		expect(session.selectedHunk).toBe("src/a.ts:1:1");
		expect(session.previewScrollTop).toBe(0);

		session.previewScrollTop = 4;
		moveSelectedFile(session, DIFF, 1);
		expect(session.selectedFile).toBe("src/b.ts");
		expect(session.selectedHunk).toBe("src/b.ts:4:4");
		expect(session.previewScrollTop).toBe(0);

		session.previewScrollTop = 3;
		moveSelectedHunk(session, DIFF, -1);
		expect(session.selectedHunk).toBe("src/b.ts:4:4");
		expect(session.previewScrollTop).toBe(0);
	});

	it("adds, edits, toggles, and deletes comments", () => {
		const session = syncReviewDiffSession(createReviewDiffSession(DIFF.mode), DIFF);
		const comment = createDraftComment({
			session,
			file: "src/a.ts",
			line: 2,
			hunkId: "src/a.ts:1:1",
			body: "Needs a regression test.",
		});
		addDraftComment(session, comment);
		expect(session.selectedCommentId).toBe("C001");
		expect(getSubmittableComments(session)).toHaveLength(1);

		toggleSelectedCommentStatus(session, "dismissed");
		expect(getSubmittableComments(session)).toHaveLength(0);

		toggleSelectedCommentStatus(session, "approved");
		editSelectedComment(session, "Needs a focused regression test.");
		expect(session.comments[0]?.status).toBe("edited");
		expect(session.comments[0]?.originalBody).toBe("Needs a regression test.");

		moveSelectedComment(session, 1);
		expect(session.selectedCommentId).toBe("C001");

		deleteSelectedComment(session);
		expect(session.comments).toHaveLength(0);
		expect(session.selectedCommentId).toBeUndefined();
	});
});
