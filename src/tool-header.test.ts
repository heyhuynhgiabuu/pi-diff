import { strict as assert } from "node:assert";
import { Box, Spacer, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, it, vi } from "vitest";
import diffRendererExtension, { __testing } from "./index.js";

vi.mock("./core/config.js", () => ({
	configIndicatorStyle: () => undefined,
	loadPiDiffConfig: () => ({}),
}));

describe("tool header names", () => {
	it("prefixes write, edit, and apply_patch with a left arrow", () => {
		assert.equal(__testing.formatToolHeaderName("write"), "← write");
		assert.equal(__testing.formatToolHeaderName("create"), "← create");
		assert.equal(__testing.formatToolHeaderName("edit"), "← edit");
		assert.equal(__testing.formatToolHeaderName("apply_patch"), "← apply_patch");
		assert.equal(__testing.formatToolHeaderName("read"), "read");
	});

	it("uses toolTitle for tool header paths", () => {
		const theme = { fg: (name: string, text: string) => `${name}:${text}` };
		assert.equal(__testing.formatToolHeaderPath(theme, "src/index.ts"), "toolTitle:src/index.ts");
	});

	it("uses the tool result error flag when rendering failures", () => {
		const testing = __testing as typeof __testing & {
			isToolResultError(result: { isError?: boolean }, context: { isError?: boolean }): boolean;
		};
		assert.equal(testing.isToolResultError({ isError: true }, { isError: false }), true);
		assert.equal(testing.isToolResultError({ isError: false }, { isError: true }), true);
		assert.equal(testing.isToolResultError({ isError: false }, { isError: false }), false);
	});
});

type Renderable = { render(width: number): string[] };

const renderTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	getFgAnsi: () => "\x1b[38;2;100;180;120m",
	getBgAnsi: () => "\x1b[48;2;10;10;10m",
};

async function getRenderedTools(): Promise<Map<string, any>> {
	const tools = new Map<string, any>();
	await diffRendererExtension({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as any);
	return tools;
}

function renderDefaultToolShell(...components: Renderable[]): string[] {
	const box = new Box(1, 1);
	for (const component of components) box.addChild(component as any);
	return [...new Spacer(1).render(80), ...box.render(80)].map(stripTerminalSequences);
}

function leadingSpaces(line: string): number {
	return line.match(/^ */)?.[0].length ?? 0;
}

function lineContaining(lines: string[], text: string): { line: string; index: number } {
	const index = lines.findIndex((line) => line.includes(text));
	assert.notEqual(index, -1, `expected a line containing ${JSON.stringify(text)}`);
	return { line: lines[index], index };
}

describe("write/edit/apply_patch shell spacing", () => {
	it("keeps one host-provided space and one top shell pad on both titles", async () => {
		const tools = await getRenderedTools();
		const cases = [
			{
				name: "write",
				args: { path: "package.json", content: "next" },
			},
			{
				name: "edit",
				args: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] },
			},
		];

		for (const { name, args } of cases) {
			assert.equal(tools.get(name).renderShell, "default");
			const call = tools.get(name).renderCall(args, renderTheme, {
				argsComplete: true,
				lastComponent: undefined,
				state: {},
				toolCallId: `${name}-call`,
			});
			const lines = renderDefaultToolShell(call);
			const title = lineContaining(lines, `← ${name}`);
			assert.equal(title.index, 2, `${name} title should follow the host spacer and top pad`);
			assert.equal(leadingSpaces(title.line), 1, `${name} title should have one leading space`);
		}
	});

	it("does not pre-pad create headers to the terminal width", async () => {
		const tools = await getRenderedTools();
		const path = `/tmp/pi-diff-layout-missing-${process.pid}`;
		const call = tools.get("write").renderCall({ path, content: "const value = 1;" }, renderTheme, {
			argsComplete: true,
			lastComponent: undefined,
			state: {},
			toolCallId: "create-call",
			invalidate() {},
		});
		const lines = renderDefaultToolShell(call);
		const title = lineContaining(lines, "← create");
		assert.equal(title.index, 2);
		assert.equal(lines.length, 5);
	});

	it("keeps one leading space on diff bodies and one trailing shell pad", async () => {
		const tools = await getRenderedTools();
		const diff = __testing.parseDiff("old();\n", "new();\n");

		for (const name of ["write", "edit"]) {
			const args =
				name === "write"
					? { path: "package.json", content: "next" }
					: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] };
			const call = tools.get(name).renderCall(args, renderTheme, {
				argsComplete: true,
				lastComponent: undefined,
				state: {},
				toolCallId: `${name}-body-call`,
			});
			const result = tools.get(name).renderResult(
				{
					content: [{ type: "text", text: "ok" }],
					details: { _type: name === "write" ? "diff" : "editInfo", diff, language: undefined },
				},
				{ expanded: true, isPartial: false },
				renderTheme,
				{ args, state: {}, lastComponent: undefined, invalidate() {}, isError: false },
			);
			const lines = renderDefaultToolShell(call, result);
			const body = lineContaining(lines, "rendering diff");
			assert.equal(leadingSpaces(body.line), 1, `${name} diff body should have one leading space`);
			let trailingBlankLines = 0;
			for (let index = lines.length - 1; index >= 0 && lines[index].trim() === ""; index--) trailingBlankLines++;
			assert.equal(trailingBlankLines, 1, `${name} diff should have one trailing shell pad`);
		}
	});

	it("keeps one leading space on non-diff result lines and error messages", async () => {
		const tools = await getRenderedTools();
		const cases = [
			{
				name: "write",
				args: { path: "package.json", content: "next" },
				result: { content: [{ type: "text", text: "✓ no changes" }], details: { _type: "noChange" } },
				needle: "✓ no changes",
			},
			{
				name: "edit",
				args: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] },
				result: { content: [{ type: "text", text: "done" }], details: undefined },
				needle: "done",
			},
		];

		for (const { name, args, result, needle } of cases) {
			const body = tools.get(name).renderResult(result, { expanded: true, isPartial: false }, renderTheme, {
				args,
				state: {},
				lastComponent: undefined,
				invalidate() {},
				isError: false,
			});
			const lines = renderDefaultToolShell(body);
			const line = lineContaining(lines, needle);
			assert.equal(leadingSpaces(line.line), 1, `${name} result should have one leading space`);
		}

		for (const name of ["write", "edit"]) {
			const args =
				name === "write"
					? { path: "package.json", content: "next" }
					: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] };
			const error = tools
				.get(name)
				.renderResult(
					{ content: [{ type: "text", text: "failure" }], isError: true },
					{ expanded: true, isPartial: false },
					renderTheme,
					{ args, state: {}, lastComponent: undefined, invalidate() {}, isError: true },
				);
			const lines = renderDefaultToolShell(error);
			assert.equal(leadingSpaces(lineContaining(lines, `← ${name}`).line), 1, `${name} error title should be aligned`);
			assert.equal(leadingSpaces(lineContaining(lines, "failure").line), 1, `${name} error should be aligned`);
		}
	});

	it("applies the same minimal shell spacing to apply_patch", async () => {
		const tools = await getRenderedTools();
		const tool = tools.get("apply_patch");
		assert.equal(tool.renderShell, "default");
		const change = { path: "package.json", action: "update", oldText: "old", newText: "new" };

		const call = tool.renderCall({ changes: [change] }, renderTheme, {
			argsComplete: false,
			lastComponent: undefined,
			state: {},
			toolCallId: "apply-call",
		});
		const callTitle = lineContaining(renderDefaultToolShell(call), "← apply_patch");
		assert.equal(callTitle.index, 2);
		assert.equal(leadingSpaces(callTitle.line), 1);

		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					_type: "applyPatchInfo",
					result: {
						ok: true,
						applied: [{ action: "update", path: "package.json", oldContent: "old();\n", newContent: "new();\n" }],
						errors: [],
					},
				},
			},
			{ expanded: true, isPartial: false },
			renderTheme,
			{ args: { changes: [change] }, state: {}, lastComponent: undefined, invalidate() {}, isError: false },
		);
		const resultLines = renderDefaultToolShell(result);
		assert.equal(leadingSpaces(lineContaining(resultLines, "rendering diff").line), 1);
		let trailingBlankLines = 0;
		for (let index = resultLines.length - 1; index >= 0 && resultLines[index].trim() === ""; index--)
			trailingBlankLines++;
		assert.equal(trailingBlankLines, 1);

		const error = tool.renderResult(
			{ content: [{ type: "text", text: "failure" }], isError: true },
			{ expanded: true, isPartial: false },
			renderTheme,
			{ args: { changes: [change] }, state: {}, lastComponent: undefined, invalidate() {}, isError: true },
		);
		const errorLines = renderDefaultToolShell(error);
		assert.equal(leadingSpaces(lineContaining(errorLines, "← apply_patch").line), 1);
		assert.equal(leadingSpaces(lineContaining(errorLines, "failure").line), 1);
	});
});
