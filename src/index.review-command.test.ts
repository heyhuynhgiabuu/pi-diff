import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import diffRendererExtension from "./index.js";

const mocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	copyToClipboard: mocks.copyToClipboard,
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
	truncateToWidth: (text: string) => text,
	visibleWidth: (text: string) => text.length,
	wrapTextWithAnsi: (text: string) => [text],
}));

const originalCwd = process.cwd();
let tempDir: string | null = null;

beforeEach(() => {
	mocks.copyToClipboard.mockReset();
	tempDir = mkdtempSync(join(tmpdir(), "pi-diff-review-command-"));
	process.chdir(tempDir);
	execFileSync("git", ["init"], { cwd: tempDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir });
	writeFileSync(join(tempDir, "tracked.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "tracked.ts"], { cwd: tempDir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir });
	writeFileSync(join(tempDir, "tracked.ts"), "export const value = 2;\n");
});

afterEach(() => {
	process.chdir(originalCwd);
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = null;
});

describe("diffRendererExtension review-diff command", () => {
	it("registers /review-diff and submits drafted comments back to Pi", async () => {
		const commands: Record<string, any> = {};
		const entries: Array<{ type: string; customType: string; data: unknown }> = [];
		const userMessages: Array<{ content: string; options?: unknown }> = [];
		const extensionMessages: any[] = [];

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry(customType: string, data: unknown) {
				entries.push({ type: "custom", customType, data });
			},
			sendUserMessage(content: string, options?: unknown) {
				userMessages.push({ content, options });
			},
			sendMessage(message: unknown) {
				extensionMessages.push(message);
			},
		});

		expect(commands["review-diff"]).toBeDefined();

		const notify = vi.fn();
		const custom = vi.fn().mockResolvedValueOnce({ type: "add-comment" }).mockResolvedValueOnce({ type: "submit" });
		const editor = vi.fn().mockResolvedValue("Changed exported value needs a regression test.");

		await commands["review-diff"].handler("", {
			hasUI: true,
			isIdle: () => true,
			sessionManager: {
				getBranch: () => entries,
			},
			ui: {
				notify,
				custom,
				editor,
			},
		});

		expect(custom).toHaveBeenCalledTimes(2);
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", minWidth: 84 },
		});
		expect(editor).toHaveBeenCalledTimes(1);
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0]?.content).toContain("Changed exported value needs a regression test.");
		expect(userMessages[0]?.content).toContain("Apply the following code review feedback");
		expect(entries.some((entry) => entry.customType === "review-diff-session")).toBe(true);
		expect(extensionMessages[0]).toMatchObject({ customType: "review-diff-submit" });
		expect(notify).toHaveBeenCalledWith("Queued 1 review comment(s) for Pi", "info");
	});

	it("auto-refreshes the open overlay when the local git diff changes and stops polling after close", async () => {
		vi.useFakeTimers();
		try {
			const commands: Record<string, any> = {};

			await diffRendererExtension({
				registerTool() {},
				registerCommand(name: string, command: Record<string, any>) {
					commands[name] = command;
				},
				registerMessageRenderer() {},
				on() {},
				appendEntry() {},
				sendUserMessage() {},
				sendMessage() {},
			});

			const notify = vi.fn();
			const requestRender = vi.fn();
			let component: { dispose?: () => void } | undefined;
			let closeOverlay: ((action: { type: "cancel" }) => void) | undefined;
			const custom = vi.fn().mockImplementation((factory: any) => {
				return new Promise((resolve) => {
					closeOverlay = (action: { type: "cancel" }) => {
						component?.dispose?.();
						resolve(action);
					};
					component = factory(
						{ requestRender },
						{ fg: (_token: string, text: string) => text, bold: (text: string) => text },
						null,
						closeOverlay,
					);
				});
			});

			const handlerPromise = commands["review-diff"].handler("", {
				hasUI: true,
				sessionManager: { getBranch: () => [] },
				ui: { notify, custom, editor: vi.fn() },
			});
			await Promise.resolve();

			if (!tempDir) throw new Error("tempDir not initialized");
			writeFileSync(join(tempDir, "tracked.ts"), "export const value = 3;\n");
			await vi.advanceTimersByTimeAsync(1100);
			expect(requestRender).toHaveBeenCalled();

			const refreshCalls = requestRender.mock.calls.length;
			closeOverlay?.({ type: "cancel" });
			await handlerPromise;

			writeFileSync(join(tempDir, "tracked.ts"), "export const value = 4;\n");
			await vi.advanceTimersByTimeAsync(1100);
			expect(requestRender).toHaveBeenCalledTimes(refreshCalls);
		} finally {
			vi.useRealTimers();
		}
	});

	it("loads the selected review location into the main editor", async () => {
		const commands: Record<string, any> = {};

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry() {},
			sendUserMessage() {},
			sendMessage() {},
		});

		const notify = vi.fn();
		const setEditorText = vi.fn();
		const custom = vi.fn().mockResolvedValueOnce({ type: "open-location" });

		await commands["review-diff"].handler("", {
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify, custom, editor: vi.fn(), setEditorText },
		});

		expect(setEditorText).toHaveBeenCalledWith(expect.stringContaining("File: tracked.ts:1"));
		expect(setEditorText).toHaveBeenCalledWith(expect.stringContaining("Selected line (del): export const value = 1;"));
		expect(notify).toHaveBeenCalledWith("Selected review location loaded into the editor", "info");
	});

	it("copies the selected review location to the clipboard", async () => {
		const commands: Record<string, any> = {};

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry() {},
			sendUserMessage() {},
			sendMessage() {},
		});

		const notify = vi.fn();
		const setEditorText = vi.fn();
		const custom = vi.fn().mockResolvedValueOnce({ type: "copy-location" }).mockResolvedValueOnce({ type: "cancel" });

		await commands["review-diff"].handler("", {
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify, custom, editor: vi.fn(), setEditorText },
		});

		expect(mocks.copyToClipboard).toHaveBeenCalledWith(expect.stringContaining("File: tracked.ts:1"));
		expect(mocks.copyToClipboard).toHaveBeenCalledWith(
			expect.stringContaining("Selected line (del): export const value = 1;"),
		);
		expect(setEditorText).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Selected review location copied to clipboard", "info");
	});

	it("falls back to editor text when clipboard copy fails", async () => {
		mocks.copyToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
		const commands: Record<string, any> = {};

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry() {},
			sendUserMessage() {},
			sendMessage() {},
		});

		const notify = vi.fn();
		const setEditorText = vi.fn();
		const custom = vi.fn().mockResolvedValueOnce({ type: "copy-location" }).mockResolvedValueOnce({ type: "cancel" });

		await commands["review-diff"].handler("", {
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify, custom, editor: vi.fn(), setEditorText },
		});

		expect(setEditorText).toHaveBeenCalledWith(expect.stringContaining("File: tracked.ts:1"));
		expect(notify).toHaveBeenCalledWith(
			"Clipboard unavailable; selected review location loaded into the editor",
			"warning",
		);
	});

	it("warns when edit-comment is requested with no drafted comments", async () => {
		const commands: Record<string, any> = {};

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry() {},
			sendUserMessage() {},
			sendMessage() {},
		});

		const notify = vi.fn();
		const custom = vi.fn().mockResolvedValueOnce({ type: "edit-comment" }).mockResolvedValueOnce({ type: "cancel" });
		const editor = vi.fn();

		await commands["review-diff"].handler("", {
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify, custom, editor },
		});

		expect(editor).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"No drafted comment selected. Press c to draft one first, or Tab to Comments.",
			"warning",
		);
	});

	it("reports invalid base refs without opening the overlay", async () => {
		const commands: Record<string, any> = {};

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry() {},
			sendUserMessage() {},
			sendMessage() {},
		});

		const notify = vi.fn();
		const custom = vi.fn();

		await commands["review-diff"].handler("missing-branch", {
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify, custom, editor: vi.fn() },
		});

		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Could not read git diff for missing-branch...HEAD. Verify the branch or ref exists.",
			"error",
		);
	});

	it("fails cleanly in non-interactive contexts without touching ctx.ui", async () => {
		const commands: Record<string, any> = {};
		const extensionMessages: any[] = [];

		await diffRendererExtension({
			registerTool() {},
			registerCommand(name: string, command: Record<string, any>) {
				commands[name] = command;
			},
			registerMessageRenderer() {},
			on() {},
			appendEntry() {},
			sendUserMessage() {},
			sendMessage(message: unknown) {
				extensionMessages.push(message);
			},
		});

		await expect(
			commands["review-diff"].handler("", {
				hasUI: false,
				sessionManager: { getBranch: () => [] },
			}),
		).resolves.toBeUndefined();

		expect(extensionMessages[0]).toMatchObject({
			customType: "review-diff-status",
			content: "/review-diff requires interactive mode",
			details: { level: "error" },
		});
	});
});
