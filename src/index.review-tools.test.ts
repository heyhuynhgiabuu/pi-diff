import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import diffRendererExtension from "./index.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
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

vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		value = "";
		constructor(text = "") {
			this.value = text;
		}
		setText(text: string) {
			this.value = text;
		}
		render(_width: number) {
			return this.value.split("\n");
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

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function plain(text: string): string {
	return text.replace(ANSI_RE, "");
}

async function waitUntil(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < 20; i++) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw lastError;
}

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
		writeComponent.render(80);
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
		expect(editComponent.value).toContain("+1");

		const editResult = await tools.edit.execute("edit-1", editArgs);
		expect(editResult.details).toMatchObject({ _type: "editInfo" });
		const editResultComponent = tools.edit.renderResult(editResult, {}, theme, {
			isError: false,
			lastComponent: undefined,
		});
		editResultComponent.render(80);
		expect(editResultComponent.value).toContain("+1");
		expect(editResultComponent.value).toContain("-1");
	});

	it("renders edit previews using the component render width instead of stdout columns", async () => {
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 220 });
		try {
			const tools: Record<string, any> = {};
			await diffRendererExtension({
				registerTool(tool: Record<string, any>) {
					tools[tool.name] = tool;
				},
			});

			if (!tempDir) throw new Error("tempDir missing");
			const trackedPath = join(tempDir, "tracked.txt");
			writeFileSync(trackedPath, "const value = 1;\n");
			const result = await tools.edit.execute("edit-width", {
				path: trackedPath,
				edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
			});

			const component = tools.edit.renderResult(result, {}, theme, {
				isError: false,
				lastComponent: undefined,
			});

			component.render(120);
			await waitUntil(() => expect(component.value).not.toContain("rendering"));
			expect(component.value).not.toContain("┊");
			expect(plain(component.value)).toContain("const value = 1;");
			expect(plain(component.value)).toContain("const value = 2;");
			expect(plain(component.value).split("\n").every((line) => line.length <= 120)).toBe(true);
		} finally {
			if (stdoutDescriptor) Object.defineProperty(process.stdout, "columns", stdoutDescriptor);
			else Reflect.deleteProperty(process.stdout, "columns");
		}
	});

	it("renders write diffs using the component render width instead of stdout columns", async () => {
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 220 });
		try {
			const tools: Record<string, any> = {};
			await diffRendererExtension({
				registerTool(tool: Record<string, any>) {
					tools[tool.name] = tool;
				},
			});

			if (!tempDir) throw new Error("tempDir missing");
			const trackedPath = join(tempDir, "tracked.txt");
			writeFileSync(trackedPath, "const value = 1;\n");
			const result = await tools.write.execute("write-width", {
				path: trackedPath,
				content: "const value = 2;\n",
			});

			const component = tools.write.renderResult(result, {}, theme, {
				isError: false,
				lastComponent: undefined,
				state: {},
				invalidate: () => {},
			});

			component.render(120);
			await waitUntil(() => expect(component.value).not.toContain("rendering"));
			expect(component.value).not.toContain("┊");
			expect(plain(component.value)).toContain("const value = 1;");
			expect(plain(component.value)).toContain("const value = 2;");
			expect(plain(component.value).split("\n").every((line) => line.length <= 120)).toBe(true);
		} finally {
			if (stdoutDescriptor) Object.defineProperty(process.stdout, "columns", stdoutDescriptor);
			else Reflect.deleteProperty(process.stdout, "columns");
		}
	});
});
