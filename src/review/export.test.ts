import { describe, expect, it } from "vitest";

import { formatReviewMarkdown } from "./export.js";
import type { ReviewDiff } from "./git.js";

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

describe("formatReviewMarkdown", () => {
	it("emits agent-ready review context with line numbers", () => {
		const markdown = formatReviewMarkdown(DIFF);

		expect(markdown).toContain("# Code Review Context");
		expect(markdown).toContain("- src/a.ts (modified, +1/-1, 1 hunks)");
		expect(markdown).toContain("### src/a.ts:1");
		expect(markdown).toContain("-   2 const b = 2;");
		expect(markdown).toContain("+   2 const b = 3;");
	});
});
