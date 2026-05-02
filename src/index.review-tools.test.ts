import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import diffRendererExtension from "./index.js";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	createWriteTool: () => ({
		name: "write",
		execute: async () => ({ content: [{ type: "text", text: "written" }] }),
	}),
	createEditTool: () => ({
		name: "edit",
		execute: async () => ({ content: [{ type: "text", text: "edited" }] }),
	}),
	getMarkdownTheme: () => ({ mocked: true }),
}));

vi.mock("@mariozechner/pi-tui", () => ({
	Text: class Text {
		value = "";
		constructor(text = "") {
			this.value = text;
		}
		setText(text: string) {
			this.value = text;
		}
	},
	Markdown: class Markdown {
		constructor(
			public markdown: string,
			public paddingX: number,
			public paddingY: number,
			public theme: unknown,
		) {}
	},
}));

const originalCwd = process.cwd();
let tempDir: string | null = null;

const theme = {
	bold: (text: string) => `**${text}**`,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	getFgAnsi: (color: string) => {
		if (color === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
		if (color === "toolDiffContext") return "\x1b[38;2;120;120;120m";
		return "\x1b[38;2;100;180;120m";
	},
	getBgAnsi: () => "\x1b[48;2;0;0;0m",
};

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-diff-extension-"));
	process.chdir(tempDir);
	execFileSync("git", ["init"], { cwd: tempDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir });
	writeFileSync(join(tempDir, "tracked.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "tracked.ts"], { cwd: tempDir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir });
	writeFileSync(join(tempDir, "tracked.ts"), "export const value = 2;\n");
	writeFileSync(join(tempDir, "new.ts"), "export const added = true;\n");
});

afterEach(() => {
	process.chdir(originalCwd);
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = null;
});

describe("diffRendererExtension review tools", () => {
	it("registers interactive review tools and drafts/lists/clears comments", async () => {
		const tools: Record<string, any> = {};

		await diffRendererExtension({
			registerTool(tool: Record<string, any>) {
				tools[tool.name] = tool;
			},
		});

		expect(Object.keys(tools)).toEqual(
			expect.arrayContaining(["review_git_diff", "review_git_comment", "review_git_comments", "write", "edit"]),
		);

		const panel = await tools.review_git_diff.execute("1", {});
		expect(panel.content[0].text).toContain("# Interactive Code Review");
		expect(panel.content[0].text).toContain("tracked.ts");
		expect(panel.content[0].text).toContain("new.ts");
		expect(panel.details).toMatchObject({ _type: "reviewGitDiff", fileCount: 2 });
		expect(panel.details.markdown).toContain("# Interactive Code Review");
		const renderedPanel = tools.review_git_diff.renderResult(
			panel,
			{},
			{},
			{ lastComponent: undefined, isError: false },
		);
		expect(renderedPanel.markdown).toContain("# Interactive Code Review");

		const focused = await tools.review_git_diff.execute("2", { file: "tracked.ts" });
		expect(focused.content[0].text).toContain("## File: tracked.ts");
		expect(focused.content[0].text).toContain("review_git_comment");

		const comment = await tools.review_git_comment.execute("3", {
			file: "tracked.ts",
			line: 1,
			body: "Changed exported value needs a regression test.",
		});
		expect(comment.details.commentCount).toBe(1);
		expect(comment.content[0].text).toContain("Drafted C001");

		const comments = await tools.review_git_comments.execute("4", {});
		expect(comments.content[0].text).toContain("Changed exported value needs a regression test.");
		const renderedComments = tools.review_git_comments.renderResult(comments, {}, {}, { lastComponent: undefined });
		expect(renderedComments.markdown).toContain("Changed exported value needs a regression test.");

		const panelWithComment = await tools.review_git_diff.execute("5", { file: "tracked.ts" });
		expect(panelWithComment.content[0].text).toContain("Comments drafted: 1");
		expect(panelWithComment.content[0].text).toContain("Drafted comments on this file: 1");

		const cleared = await tools.review_git_comments.execute("6", { clear: true });
		expect(cleared.details).toMatchObject({ cleared: 1, commentCount: 0 });
	});

	it("returns validation errors for invalid interactive limits", async () => {
		const tools: Record<string, any> = {};

		await diffRendererExtension({
			registerTool(tool: Record<string, any>) {
				tools[tool.name] = tool;
			},
		});

		const result = await tools.review_git_diff.execute("1", { maxFiles: 0 });
		expect(result.content[0].text).toContain("maxFiles must be a positive integer");
		expect(result.details.error).toContain("maxFiles");
	});

	it("keeps write and edit renderers aligned with Pi Text rendering", async () => {
		const tools: Record<string, any> = {};

		await diffRendererExtension({
			registerTool(tool: Record<string, any>) {
				tools[tool.name] = tool;
			},
		});

		if (!tempDir) throw new Error("tempDir missing");
		const trackedPath = join(tempDir, "tracked.ts");
		const writeResult = await tools.write.execute("write-1", {
			path: trackedPath,
			content: "export const value = 3;\n",
		});
		expect(writeResult.details).toMatchObject({ _type: "diff" });
		const writeComponent = tools.write.renderResult(writeResult, {}, theme, {
			isError: false,
			lastComponent: undefined,
			state: {},
			invalidate: () => {},
		});
		expect(writeComponent.value).toContain("rendering diff");

		const editArgs = {
			path: trackedPath,
			oldText: "export const value = 2;",
			newText: "export const value = 4;",
		};
		const editComponent = tools.edit.renderCall(editArgs, theme, {
			argsComplete: true,
			lastComponent: undefined,
			state: {},
			invalidate: () => {},
		});
		expect(editComponent.value).toContain("rendering");

		const editResult = await tools.edit.execute("edit-1", editArgs);
		expect(editResult.details).toMatchObject({ _type: "editInfo" });
		const editResultComponent = tools.edit.renderResult(editResult, {}, theme, {
			isError: false,
			lastComponent: undefined,
		});
		expect(editResultComponent.value).toContain("+1");
		expect(editResultComponent.value).toContain("-1");
	});
});
