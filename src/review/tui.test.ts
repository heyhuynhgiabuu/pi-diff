import { describe, expect, it, vi } from "vitest";

const TAB_WIDTH = 4;

function expandTabs(text: string): string {
	let result = "";
	let column = 0;
	for (const char of text) {
		if (char === "\t") {
			const spaces = TAB_WIDTH - (column % TAB_WIDTH || 0);
			result += " ".repeat(spaces);
			column += spaces;
			continue;
		}
		result += char;
		column += 1;
	}
	return result;
}

function visibleWidthWithTabs(text: string): number {
	return expandTabs(text).length;
}

function truncateToWidthWithTabs(text: string, width: number): string {
	return expandTabs(text).slice(0, width);
}

function wrapTextWithTabs(text: string, width: number): string[] {
	const normalized = expandTabs(text);
	if (normalized.length <= width) return [normalized];
	const parts: string[] = [];
	for (let index = 0; index < normalized.length; index += width) {
		parts.push(normalized.slice(index, index + width));
	}
	return parts;
}

vi.mock("@mariozechner/pi-tui", () => ({
	Key: {
		escape: "escape",
		enter: "enter",
		tab: "tab",
		up: "up",
		down: "down",
		left: "left",
		right: "right",
		ctrl: (key: string) => `ctrl+${key}`,
		shift: (key: string) => `shift+${key}`,
	},
	matchesKey: (value: string, expected: string) => value === expected,
	truncateToWidth: truncateToWidthWithTabs,
	visibleWidth: visibleWidthWithTabs,
	wrapTextWithAnsi: wrapTextWithTabs,
}));

import type { ReviewDiff } from "./git.js";
import { createReviewDiffSession, syncReviewDiffSession } from "./session.js";
import { ReviewDiffPane } from "./tui.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

describe("ReviewDiffPane", () => {
	it("keeps the selected file, hunk, preview anchor, and comment visible inside capped lists", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: Array.from({ length: 15 }, (_, fileIndex) => ({
				oldPath: `src/file-${fileIndex + 1}.ts`,
				newPath: `src/file-${fileIndex + 1}.ts`,
				path: `src/file-${fileIndex + 1}.ts`,
				status: "modified" as const,
				hunks: Array.from({ length: 10 }, (_, hunkIndex) => ({
					id: `src/file-${fileIndex + 1}.ts:${hunkIndex + 1}:${hunkIndex + 1}`,
					oldStart: hunkIndex + 1,
					oldLines: 1,
					newStart: hunkIndex + 1,
					newLines: 1,
					header: `@@ -${hunkIndex + 1},1 +${hunkIndex + 1},1 @@`,
					lines: [{ type: "add" as const, oldNum: null, newNum: hunkIndex + 1, content: `line ${hunkIndex + 1}` }],
				})),
			})),
		};
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		session.selectedFile = "src/file-15.ts";
		session.selectedHunk = "src/file-15.ts:10:10";
		session.selectedPreviewLineId = "src/file-15.ts:src/file-15.ts:10:10:add:_:10:0";
		session.comments = Array.from({ length: 12 }, (_, index) => ({
			id: `C${String(index + 1).padStart(3, "0")}`,
			file: "src/file-15.ts",
			line: index + 1,
			hunkId: `src/file-15.ts:${Math.min(index + 1, 10)}:${Math.min(index + 1, 10)}`,
			previewLineId: `src/file-15.ts:src/file-15.ts:${Math.min(index + 1, 10)}:${Math.min(index + 1, 10)}:add:_:${Math.min(index + 1, 10)}:0`,
			newNum: index + 1,
			lineType: "add" as const,
			body: `Comment ${index + 1}`,
			createdAt: new Date(2024, 0, index + 1).toISOString(),
			status: "approved" as const,
		}));
		session.selectedCommentId = "C012";
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, {
			renderFilePreview: vi.fn().mockResolvedValue(["preview line 1", "preview line 2"]),
		});

		pane.render(120);
		await Promise.resolve();
		const rendered = pane.render(120).join("\n");

		expect(rendered).toContain("15 files │ +150 -0");
		expect(rendered).toContain("▶ src/file-15.ts (modified, +10/-0, 10 hunks)");
		expect(rendered).toContain("▶ src/file-15.ts:10:10 (+1/-0) @@ -10,1 +10,1 @@");
		expect(rendered).toContain("▶ C012 src/file-15.ts:12 [approved]");
		expect(rendered).toContain("preview line 1");
		expect(rendered).toContain("… 3 earlier files");
		expect(rendered).toContain("… 2 earlier hunks");
		expect(rendered).toContain("… 2 earlier comments");
	});

	it("shows exact header and per-file add/delete counts for mixed diffs", async () => {
		const diff: ReviewDiff = {
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
								{ type: "del", oldNum: 1, newNum: null, content: "old" },
								{ type: "add", oldNum: null, newNum: 1, content: "new" },
							],
						},
					],
				},
			],
		};
		const pane = new ReviewDiffPane(
			diff,
			syncReviewDiffSession(createReviewDiffSession(diff.mode), diff),
			theme as any,
			() => {},
			{
				renderFilePreview: vi.fn().mockResolvedValue(["preview"]),
			},
		);

		pane.render(100);
		await Promise.resolve();
		const rendered = pane.render(100).join("\n");

		expect(rendered).toContain("1 files │ +1 -1");
		expect(rendered).toContain("▶ src/a.ts (modified, +1/-1, 1 hunks)");
		expect(rendered).toContain("▶ src/a.ts:1:1 (+1/-1) @@ -1,2 +1,2 @@");
	});

	it("keeps rendered File diff content visible while arrow scrolling re-highlights asynchronously", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/cache.ts",
					newPath: "src/cache.ts",
					path: "src/cache.ts",
					status: "modified",
					hunks: [
						{
							id: "src/cache.ts:1:1",
							oldStart: 1,
							oldLines: 30,
							newStart: 1,
							newLines: 30,
							header: "@@ -1,30 +1,30 @@",
							lines: Array.from({ length: 30 }, (_, index) => ({
								type: "add" as const,
								oldNum: null,
								newNum: index + 1,
								content: `line ${index + 1}`,
							})),
						},
					],
				},
			],
		};
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		const renderFilePreview = vi
			.fn()
			.mockResolvedValue(Array.from({ length: 31 }, (_, index) => `cached preview ${index + 1}`));
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, { renderFilePreview });

		pane.render(120);
		await Promise.resolve();
		let rendered = pane.render(120).join("\n");
		expect(rendered).toContain("cached preview 1");
		expect(renderFilePreview).toHaveBeenCalledTimes(1);

		pane.handleInput("tab");
		pane.handleInput("tab");
		pane.handleInput("down");
		rendered = pane.render(120).join("\n");
		expect(session.previewScrollTop).toBe(1);
		expect(rendered).toContain("cached preview 2");
		expect(rendered).not.toContain("rendering diff");
		expect(renderFilePreview).toHaveBeenCalledTimes(1);
	});

	it("supports mouse-wheel scrolling in the File diff viewport", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/mouse.ts",
					newPath: "src/mouse.ts",
					path: "src/mouse.ts",
					status: "modified",
					hunks: [
						{
							id: "src/mouse.ts:1:1",
							oldStart: 1,
							oldLines: 40,
							newStart: 1,
							newLines: 40,
							header: "@@ -1,40 +1,40 @@",
							lines: Array.from({ length: 40 }, (_, index) => ({
								type: "add" as const,
								oldNum: null,
								newNum: index + 1,
								content: `line ${index + 1}`,
							})),
						},
					],
				},
			],
		};
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, {
			renderFilePreview: vi.fn().mockResolvedValue(["preview"]),
		});

		pane.render(120);
		await Promise.resolve();
		let rendered = pane.render(120).join("\n");
		expect(session.previewScrollTop).toBe(0);

		pane.handleInput("\u001b[<65;20;10M");
		rendered = pane.render(120).join("\n");
		expect(session.previewScrollTop).toBe(3);
		expect(rendered).toContain("mouse wheel/↑↓/pgup/pgdn/home/end scroll");
	});

	it("keeps the File diff section at a fixed viewport height with scroll indicators", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/scroll.ts",
					newPath: "src/scroll.ts",
					path: "src/scroll.ts",
					status: "modified",
					hunks: [
						{
							id: "src/scroll.ts:1:1",
							oldStart: 1,
							oldLines: 30,
							newStart: 1,
							newLines: 30,
							header: "@@ -1,30 +1,30 @@",
							lines: Array.from({ length: 30 }, (_, index) => ({
								type: "add" as const,
								oldNum: null,
								newNum: index + 1,
								content: `line ${index + 1}`,
							})),
						},
					],
				},
			],
		};
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, {
			renderFilePreview: vi.fn().mockResolvedValue(Array.from({ length: 31 }, (_, index) => `preview ${index + 1}`)),
		});

		pane.render(120);
		await Promise.resolve();
		let rendered = pane.render(120).join("\n");
		expect(rendered).toContain("Fixed 20-line hunk viewport • 1-18/31");
		expect(rendered).not.toContain("earlier preview lines");
		expect(rendered).toContain("preview 18");

		pane.handleInput("tab");
		pane.handleInput("tab");
		pane.handleInput("pageDown");
		rendered = pane.render(120).join("\n");
		expect(session.previewScrollTop).toBe(13);
		expect(rendered).toContain("Fixed 20-line hunk viewport • 14-31/31");
		expect(rendered).toContain("preview 14");
		expect(rendered).toContain("preview 31");
	});

	it("uses the full available overlay width minus only the safety margin", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/wide.ts",
					newPath: "src/wide.ts",
					path: "src/wide.ts",
					status: "modified",
					hunks: [
						{
							id: "src/wide.ts:1:1",
							oldStart: 1,
							oldLines: 1,
							newStart: 1,
							newLines: 1,
							header: "@@ -1,1 +1,1 @@",
							lines: [{ type: "add", oldNum: null, newNum: 1, content: "wide" }],
						},
					],
				},
			],
		};
		const pane = new ReviewDiffPane(
			diff,
			syncReviewDiffSession(createReviewDiffSession(diff.mode), diff),
			theme as any,
			() => {},
			{ renderFilePreview: vi.fn().mockResolvedValue(["preview"]) },
		);

		const renderedLines = pane.render(200);
		expect(Math.max(...renderedLines.map((line) => visibleWidthWithTabs(line)))).toBe(197);
	});

	it("expands tabbed preview lines and keeps every rendered line within the pane width budget", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "package.json",
					newPath: "package.json",
					path: "package.json",
					status: "modified",
					hunks: [
						{
							id: "package.json:21:21",
							oldStart: 21,
							oldLines: 2,
							newStart: 21,
							newLines: 2,
							header: "@@ -21,2 +21,2 @@",
							lines: [
								{ type: "ctx", oldNum: 21, newNum: 21, content: '\t\t"shiki",' },
								{ type: "ctx", oldNum: 22, newNum: 22, content: '\t\t"terminal"' },
							],
						},
					],
				},
			],
		};
		const requestRender = vi.fn();
		const pane = new ReviewDiffPane(
			diff,
			syncReviewDiffSession(createReviewDiffSession(diff.mode), diff),
			theme as any,
			() => {},
			{
				requestRender,
				renderFilePreview: vi.fn().mockResolvedValue(['\t\t"shiki",', '\t\t"terminal"']),
			},
		);

		pane.render(78);
		await Promise.resolve();
		await Promise.resolve();
		const renderedLines = pane.render(78);
		expect(requestRender).toHaveBeenCalled();
		expect(renderedLines.every((line) => visibleWidthWithTabs(line) <= 75)).toBe(true);
		expect(renderedLines.some((line) => line.includes("\t"))).toBe(false);
		expect(renderedLines.join("\n")).toContain('"shiki",');
	});

	it("dispatches open-location on o so the command can load the selected file/line into Pi", () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/example.ts",
					newPath: "src/example.ts",
					path: "src/example.ts",
					status: "modified",
					hunks: [
						{
							id: "src/example.ts:10:10",
							oldStart: 10,
							oldLines: 1,
							newStart: 10,
							newLines: 1,
							header: "@@ -10,1 +10,1 @@",
							lines: [{ type: "ctx", oldNum: 10, newNum: 10, content: "const value = 1;" }],
						},
					],
				},
			],
		};
		const onDone = vi.fn();
		const pane = new ReviewDiffPane(
			diff,
			syncReviewDiffSession(createReviewDiffSession(diff.mode), diff),
			theme as any,
			onDone,
			{
				renderFilePreview: vi.fn().mockResolvedValue(["preview"]),
			},
		);

		pane.handleInput("o");
		expect(onDone).toHaveBeenCalledWith({ type: "open-location" });
	});

	it("dispatches copy-location on y so the command can copy the selected file/line reference", () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/example.ts",
					newPath: "src/example.ts",
					path: "src/example.ts",
					status: "modified",
					hunks: [
						{
							id: "src/example.ts:10:10",
							oldStart: 10,
							oldLines: 1,
							newStart: 10,
							newLines: 1,
							header: "@@ -10,1 +10,1 @@",
							lines: [{ type: "ctx", oldNum: 10, newNum: 10, content: "const value = 1;" }],
						},
					],
				},
			],
		};
		const onDone = vi.fn();
		const pane = new ReviewDiffPane(
			diff,
			syncReviewDiffSession(createReviewDiffSession(diff.mode), diff),
			theme as any,
			onDone,
			{
				renderFilePreview: vi.fn().mockResolvedValue(["preview"]),
			},
		);

		pane.handleInput("y");
		expect(onDone).toHaveBeenCalledWith({ type: "copy-location" });
	});

	it("dispatches edit-comment on e even outside comments focus so the command can surface a warning", () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/example.ts",
					newPath: "src/example.ts",
					path: "src/example.ts",
					status: "modified",
					hunks: [
						{
							id: "src/example.ts:10:10",
							oldStart: 10,
							oldLines: 1,
							newStart: 10,
							newLines: 1,
							header: "@@ -10,1 +10,1 @@",
							lines: [{ type: "ctx", oldNum: 10, newNum: 10, content: "const value = 1;" }],
						},
					],
				},
			],
		};
		const onDone = vi.fn();
		const pane = new ReviewDiffPane(
			diff,
			syncReviewDiffSession(createReviewDiffSession(diff.mode), diff),
			theme as any,
			onDone,
			{
				renderFilePreview: vi.fn().mockResolvedValue(["preview"]),
			},
		);

		pane.handleInput("e");
		expect(onDone).toHaveBeenCalledWith({ type: "edit-comment" });
	});

	it("supports page and boundary navigation in the focused preview viewport", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/large.ts",
					newPath: "src/large.ts",
					path: "src/large.ts",
					status: "modified",
					hunks: [
						{
							id: "src/large.ts:1:1",
							oldStart: 1,
							oldLines: 40,
							newStart: 1,
							newLines: 40,
							header: "@@ -1,40 +1,40 @@",
							lines: Array.from({ length: 40 }, (_, index) => ({
								type: "add" as const,
								oldNum: null,
								newNum: index + 1,
								content: `line ${index + 1}`,
							})),
						},
					],
				},
			],
		};
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, {
			renderFilePreview: vi.fn().mockResolvedValue(["preview"]),
		});

		pane.render(100);
		pane.handleInput("tab");
		pane.handleInput("tab");
		expect(session.previewScrollTop).toBe(0);

		pane.handleInput("pageDown");
		expect(session.previewScrollTop).toBe(19);

		pane.handleInput("end");
		expect(session.previewScrollTop).toBe(23);

		pane.handleInput("home");
		expect(session.previewScrollTop).toBe(0);
	});

	it("renders the focused file viewport through an async preview renderer and refreshes the pane when ready", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/example.ts",
					newPath: "src/example.ts",
					path: "src/example.ts",
					status: "modified",
					hunks: [
						{
							id: "src/example.ts:10:10",
							oldStart: 10,
							oldLines: 1,
							newStart: 10,
							newLines: 2,
							header: "@@ -10,1 +10,2 @@",
							lines: [
								{ type: "ctx", oldNum: 10, newNum: 10, content: "const value = 1;" },
								{ type: "add", oldNum: null, newNum: 11, content: "const next = value + 1;" },
							],
						},
					],
				},
			],
		};
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		const requestRender = vi.fn();
		const renderFilePreview = vi.fn().mockResolvedValue(["PREVIEW", "const next = value + 1;"]);
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, { requestRender, renderFilePreview });

		expect(pane.render(100).join("\n")).toContain("rendering diff");
		await Promise.resolve();
		await Promise.resolve();
		expect(requestRender).toHaveBeenCalled();
		const rendered = pane.render(100).join("\n");
		expect(rendered).toContain("PREVIEW");
		expect(rendered).toContain("const next = value + 1;");
		expect(renderFilePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: "src/example.ts",
				width: expect.any(Number),
			}),
		);
	});

	it("moves the ▶ selection marker to the correct rendered line when pressing up/down", async () => {
		const diff: ReviewDiff = {
			mode: { type: "working-tree" },
			raw: "",
			files: [
				{
					oldPath: "src/nav.ts",
					newPath: "src/nav.ts",
					path: "src/nav.ts",
					status: "modified",
					hunks: [
						{
							id: "src/nav.ts:1:1",
							oldStart: 1,
							oldLines: 4,
							newStart: 1,
							newLines: 4,
							header: "@@ -1,4 +1,4 @@",
							lines: [
								{ type: "ctx", oldNum: 1, newNum: 1, content: "line-A" },
								{ type: "del", oldNum: 2, newNum: null, content: "line-B-del" },
								{ type: "add", oldNum: null, newNum: 2, content: "line-B-add" },
								{ type: "ctx", oldNum: 3, newNum: 3, content: "line-C" },
							],
						},
					],
				},
			],
		};
		// Lines: [header(0), ctx:A(1), del:B(2), add:B(3), ctx:C(4)] — 5 total, 4 selectable
		// renderReviewFilePreview returns one row per line with a leading space for the marker placeholder.
		// We use " LINE-X" format so applyPreviewSelection can replace the space with ▶.
		const previewRows = [" HEADER", " LINE-A", " LINE-B-del", " LINE-B-add", " LINE-C"];
		const session = syncReviewDiffSession(createReviewDiffSession(diff.mode), diff);
		const pane = new ReviewDiffPane(diff, session, theme as any, () => {}, {
			renderFilePreview: vi.fn().mockResolvedValue(previewRows),
		});

		// Render and wait for async preview
		pane.render(120);
		await Promise.resolve();

		// Initial: ▶ on first selectable = LINE-A (lines[1])
		let rendered = pane.render(120).join("\n");
		expect(rendered).toContain("▶LINE-A");
		expect(rendered).not.toContain("▶LINE-B-del");

		// Tab to preview focus
		pane.handleInput("tab");
		pane.handleInput("tab");

		// Press down once: ▶ should move to LINE-B-del
		pane.handleInput("down");
		rendered = pane.render(120).join("\n");
		expect(rendered).toContain("▶LINE-B-del");
		expect(rendered).not.toContain("▶LINE-A");

		// Press down again: ▶ should move to LINE-B-add
		pane.handleInput("down");
		rendered = pane.render(120).join("\n");
		expect(rendered).toContain("▶LINE-B-add");
		expect(rendered).not.toContain("▶LINE-B-del");

		// Press up once: ▶ should return to LINE-B-del
		pane.handleInput("up");
		rendered = pane.render(120).join("\n");
		expect(rendered).toContain("▶LINE-B-del");
		expect(rendered).not.toContain("▶LINE-B-add");
	});
});
