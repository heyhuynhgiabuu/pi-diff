import { describe, expect, it, vi } from "vitest";

vi.mock("@shikijs/cli", () => ({
	codeToANSI: vi.fn(async (code: string) => code),
}));

import { renderReviewHunkPreview } from "./hunk-preview.js";

describe("renderReviewHunkPreview", () => {
	it("renders a focused hunk with real diff line numbers and changed content", async () => {
		const preview = await renderReviewHunkPreview({
			filePath: "src/example.ts",
			width: 72,
			hunk: {
				id: "src/example.ts:10:10",
				oldStart: 10,
				oldLines: 2,
				newStart: 10,
				newLines: 3,
				header: "@@ -10,2 +10,3 @@",
				lines: [
					{ type: "ctx", oldNum: 10, newNum: 10, content: "const value = 1;" },
					{ type: "del", oldNum: 11, newNum: null, content: "return value;" },
					{ type: "add", oldNum: null, newNum: 11, content: "const next = value + 1;" },
					{ type: "add", oldNum: null, newNum: 12, content: "return next;" },
				],
			},
		});

		expect(preview).toContain("const next = value + 1;");
		expect(preview).toContain("return next;");
		expect(preview).toContain("11");
		expect(preview).toContain("12");
		expect(preview.split("\n").length).toBeGreaterThan(3);
	});
});
