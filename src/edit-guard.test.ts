// SPDX-License-Identifier: MIT
// Unit tests for the edit guard.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerEditGuard } from "./edit-guard.js";

let tempDir: string | null = null;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-diff-edit-guard-"));
});

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = null;
});

describe("registerEditGuard", () => {
	it("does nothing when pi.on is not a function", () => {
		expect(() => registerEditGuard({})).not.toThrow();
		expect(() => registerEditGuard(null)).not.toThrow();
	});

	it("registers a tool_call handler when pi.on is available", () => {
		const handlers: Array<[string, unknown]> = [];
		registerEditGuard({ on: (event, handler) => handlers.push([event, handler]) });
		expect(handlers).toHaveLength(1);
		expect(handlers[0][0]).toBe("tool_call");
	});

	it("blocks edit calls whose oldText is missing from the file", async () => {
		if (!tempDir) throw new Error("tempDir missing");
		const file = join(tempDir, "a.ts");
		writeFileSync(file, "const v = 1;\n");

		const handler = captureHandler();
		const result = await handler({
			toolName: "edit",
			input: {
				path: file,
				edits: [{ oldText: "missing text", newText: "x" }],
			},
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(file);
	});

	it("allows edit calls whose oldText is present in the file", async () => {
		if (!tempDir) throw new Error("tempDir missing");
		const file = join(tempDir, "a.ts");
		writeFileSync(file, "const v = 1;\n");

		const handler = captureHandler();
		const result = await handler({
			toolName: "edit",
			input: {
				path: file,
				edits: [{ oldText: "const v = 1;", newText: "const v = 2;" }],
			},
		});
		expect(result).toBeUndefined();
	});

	it("ignores non-array edits and unredable files", async () => {
		const handler = captureHandler();
		expect(await handler({ toolName: "edit", input: { path: "/nope", edits: null } })).toBeUndefined();
		expect(await handler({ toolName: "edit", input: { path: "/nope" } })).toBeUndefined();
	});
});

function captureHandler() {
	const handlers: Array<unknown> = [];
	registerEditGuard({ on: (_event: string, handler: unknown) => handlers.push(handler) });
	return handlers[0] as (event: { toolName: string; input: { path: string; edits?: Array<{ oldText: string; newText: string }> | null } }) => Promise<{ block: boolean; reason: string } | undefined>;
}
