import { describe, expect, it, vi } from "vitest";

vi.mock("@shikijs/cli", () => ({
	codeToANSI: vi.fn(async (code: string) => code),
}));

import { renderReviewFilePreview } from "./file-preview.js";
import type { ReviewViewportLine } from "./model.js";

const lines: ReviewViewportLine[] = [
	{
		id: "src/example.ts:h:header",
		filePath: "src/example.ts",
		hunkId: "h",
		kind: "hunk-header",
		oldNum: 1,
		newNum: 1,
		content: "@@ -1,2 +1,2 @@",
		commentCount: 0,
		isSelectable: false,
	},
	{
		id: "src/example.ts:h:del:1:_:0",
		filePath: "src/example.ts",
		hunkId: "h",
		kind: "del",
		oldNum: 1,
		newNum: null,
		content: "const oldValue = 1;",
		commentCount: 0,
		isSelectable: true,
	},
	{
		id: "src/example.ts:h:add:_:1:1",
		filePath: "src/example.ts",
		hunkId: "h",
		kind: "add",
		oldNum: null,
		newNum: 1,
		content: "const newValue = 2;",
		commentCount: 0,
		isSelectable: true,
	},
];

describe("renderReviewFilePreview", () => {
	it("does not blank the preview when theme.bg exists but is not a raw ANSI provider", async () => {
		const theme = {
			fg: (_token: string, text: string) => text,
			bg: vi.fn(() => {
				throw new Error("theme.bg requires text and must not be called as raw ANSI");
			}),
		};

		const preview = await renderReviewFilePreview({
			filePath: "src/example.ts",
			lines,
			theme,
			width: 80,
		});

		expect(theme.bg).not.toHaveBeenCalled();
		expect(preview).toHaveLength(3);
		expect(preview.join("\n")).toContain("const oldValue = 1;");
		expect(preview.join("\n")).toContain("const newValue = 2;");
	});

	it("renders binary files as safe placeholders instead of raw bytes", async () => {
		const preview = await renderReviewFilePreview({
			filePath: "media/screenshot.png",
			lines,
			theme: { fg: (_token: string, text: string) => text },
			width: 80,
		});

		expect(preview.join("\n")).toContain("(binary)");
		expect(preview.join("\n")).not.toContain("const oldValue = 1;");
	});
});
