import { describe, expect, it } from "vitest";
import type { ReviewDiff } from "./git.js";
import { createReviewComment, formatInteractiveReviewPanel, formatReviewComments } from "./interactive.js";

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
					newLines: 2,
					header: "@@ -1,2 +1,2 @@",
					lines: [
						{ type: "ctx", oldNum: 1, newNum: 1, content: "const a = 1;" },
						{ type: "del", oldNum: 2, newNum: null, content: "const b = 2;" },
						{ type: "add", oldNum: null, newNum: 2, content: "const b = 3;" },
					],
				},
			],
		},
	],
};

describe("formatInteractiveReviewPanel", () => {
	it("emits changed files and focus actions", () => {
		const panel = formatInteractiveReviewPanel(DIFF);

		expect(panel).toContain("# Interactive Code Review");
		expect(panel).toContain("review_git_diff({ file:");
		expect(panel).toContain("src/a.ts (modified, +1/-1, 1 hunks)");
	});

	it("focuses a file and hunk", () => {
		const panel = formatInteractiveReviewPanel(DIFF, [], { file: "src/a.ts", hunkId: "src/a.ts:1:1" });

		expect(panel).toContain("## File: src/a.ts");
		expect(panel).toContain("### Hunk src/a.ts:1:1");
		expect(panel).toContain("File: src/a.ts, hunk: src/a.ts:1:1, first changed line: 2");
	});
});

describe("review comments", () => {
	it("creates and formats drafted comments", () => {
		const comment = createReviewComment({
			comments: [],
			file: "src/a.ts",
			line: 2,
			body: "This changed behavior needs a test.",
			now: new Date("2026-01-01T00:00:00Z"),
		});

		expect(comment).toMatchObject({ id: "C001", file: "src/a.ts", line: 2 });
		expect(formatReviewComments([comment])).toContain("This changed behavior needs a test.");
	});
});
