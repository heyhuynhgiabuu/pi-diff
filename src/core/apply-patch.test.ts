import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApplyPatchChange, executeApplyPatch as runApplyPatch } from "./apply-patch.js";

describe("executeApplyPatch source-safe updates", () => {
	let tempDir: string;
	let filePath: string;

	function executeApplyPatch(changes: ApplyPatchChange[]) {
		return runApplyPatch(changes, { cwd: tempDir, root: tempDir });
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
		filePath = join(tempDir, "source.ts");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves the source indentation when matching an unambiguous shifted block", async () => {
		writeFileSync(filePath, "function f() {\n    first();\n    second();\n}\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n  second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\n    firstUpdated();\n    secondUpdated();\n}\n");
	});

	it("rejects a stale block instead of replacing everything between loose anchors", async () => {
		const source = "function f() {\n  keep1();\n  keep2();\n  keep3();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "function f() {\n  keep1();\n  invented();\n}",
				newText: "REPLACED",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("recovers Unicode punctuation drift via the fuzzy fallback", async () => {
		writeFileSync(filePath, "const label = \u201Chello\u201D;\nconst other = 2;\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: 'const label = "hello";\n', newText: 'const label = "hi";\n' },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe('const label = "hi";\nconst other = 2;\n');
	});

	it("recovers escaped newlines in oldText via the fuzzy fallback", async () => {
		writeFileSync(filePath, "line1\nline2\nline3\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "line1\\nline2\n", newText: "joined\n" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("joined\nline3\n");
	});

	it("refuses a non-uniform indentation drift instead of guessing", async () => {
		const source = "function f() {\n    first();\n  second();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n  second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("reports an ambiguous oldText as a uniqueness failure", async () => {
		writeFileSync(filePath, "const a = 1;\nconst a = 1;\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "const a = 1;\n", newText: "const a = 2;\n" },
		]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]?.error).toMatch(/matches 2 times/);
		expect(result.errors[0]?.error).toMatch(/unique/);
	});

	it("reports a missing oldText as not found", async () => {
		writeFileSync(filePath, "hello\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "missing\n", newText: "x\n" },
		]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]?.error).toMatch(/not found/);
	});

	it("does not apply earlier changes when a later change is invalid", async () => {
		const otherPath = join(tempDir, "other.ts");
		writeFileSync(filePath, "const first = 1;\n");
		writeFileSync(otherPath, "const second = 2;\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "const first = 1;", newText: "const first = 10;" },
			{ path: otherPath, action: "update", oldText: "missing", newText: "const second = 20;" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("const first = 1;\n");
		expect(readFileSync(otherPath, "utf8")).toBe("const second = 2;\n");
	});

	it("does not overwrite existing files for add or move", async () => {
		const sourcePath = join(tempDir, "move-source.ts");
		const destinationPath = join(tempDir, "move-destination.ts");
		writeFileSync(filePath, "original add target\n");
		writeFileSync(sourcePath, "source\n");
		writeFileSync(destinationPath, "destination\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "add", content: "replacement" },
			{ path: sourcePath, action: "move", movePath: destinationPath },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("original add target\n");
		expect(readFileSync(sourcePath, "utf8")).toBe("source\n");
		expect(readFileSync(destinationPath, "utf8")).toBe("destination\n");
	});

	it("preserves CRLF when applying an indentation-adjusted single-line update", async () => {
		writeFileSync(filePath, "function f() {\r\n    first();\r\n}\r\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first(); ",
				newText: "  firstUpdated();",
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\r\n    firstUpdated();\r\n}\r\n");
	});

	it("rejects a partial-indentation exact match that would alter source indentation", async () => {
		const source = "function f() {\n    first();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "  first();", newText: "firstUpdated();" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("does not duplicate a trailing newline for an indentation-adjusted match", async () => {
		writeFileSync(filePath, "function f() {\n    first();\n}\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "  first(); \n", newText: "  firstUpdated();\n" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\n    firstUpdated();\n}\n");
	});

	it("rejects a mid-indent exact match that inserts multiple lines", async () => {
		const source = "function f() {\n    first();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();",
				newText: "  firstUpdated();\n  inserted();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("rejects a multi-line exact match that starts inside source indentation", async () => {
		const source = "function f() {\n    first();\n    second();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n    second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("rejects batches whose operations would target the same path", async () => {
		const sourcePath = join(tempDir, "move-source.ts");
		const destinationPath = join(tempDir, "new-target.ts");
		writeFileSync(sourcePath, "source\n");

		const result = await executeApplyPatch([
			{ path: destinationPath, action: "add", content: "new file" },
			{ path: sourcePath, action: "move", movePath: destinationPath },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(sourcePath, "utf8")).toBe("source\n");
		expect(() => lstatSync(destinationPath)).toThrow();
	});

	it("preserves executable modes and refuses to replace symlinks", async () => {
		writeFileSync(filePath, "run\n");
		chmodSync(filePath, 0o755);
		const executableResult = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "run", newText: "run updated" },
		]);
		expect(executableResult.ok).toBe(true);
		expect(statSync(filePath).mode & 0o777).toBe(0o755);

		const targetPath = join(tempDir, "target.ts");
		const linkPath = join(tempDir, "link.ts");
		writeFileSync(targetPath, "target\n");
		symlinkSync(targetPath, linkPath);
		const linkResult = await executeApplyPatch([
			{ path: linkPath, action: "update", oldText: "target", newText: "changed" },
		]);
		expect(linkResult.ok).toBe(false);
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(targetPath, "utf8")).toBe("target\n");
	});

	it("deletes and moves regular files successfully", async () => {
		const deletePath = join(tempDir, "delete.ts");
		const moveSource = join(tempDir, "move-source.ts");
		const moveDestination = join(tempDir, "nested", "move-destination.ts");
		writeFileSync(deletePath, "delete me\n");
		writeFileSync(moveSource, "move me\n");

		const result = await executeApplyPatch([
			{ path: deletePath, action: "delete" },
			{ path: moveSource, action: "move", movePath: moveDestination },
		]);

		expect(result.ok).toBe(true);
		expect(() => lstatSync(deletePath)).toThrow();
		expect(() => lstatSync(moveSource)).toThrow();
		expect(readFileSync(moveDestination, "utf8")).toBe("move me\n");
	});

	it("rejects empty patches", async () => {
		const result = await executeApplyPatch([]);
		expect(result.ok).toBe(false);
		expect(result.errors[0]?.error).toBe("patch must contain at least one change");
	});

	it("preserves CR-only line endings during updates", async () => {
		writeFileSync(filePath, "first\rsecond\r", "utf8");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "second", newText: "changed" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("first\rchanged\r");
	});

	it("does not treat a lone CR inside an LF file as its line ending", async () => {
		writeFileSync(filePath, 'const value = "a\rb";\nsecond();\nthird();\n', "utf8");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "second();", newText: "changed();" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe('const value = "a\rb";\nchanged();\nthird();\n');
	});

	it("rejects paths outside the workspace root", async () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "apply-patch-outside-"));
		const outsidePath = join(outsideDir, "outside.ts");
		try {
			writeFileSync(outsidePath, "outside\n");
			const result = await runApplyPatch(
				[{ path: outsidePath, action: "update", oldText: "outside", newText: "changed" }],
				{ cwd: tempDir, root: tempDir },
			);

			expect(result.ok).toBe(false);
			expect(readFileSync(outsidePath, "utf8")).toBe("outside\n");
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("rejects ancestor symlinks even when the leaf is a regular file", async () => {
		const realDir = join(tempDir, "real");
		const linkDir = join(tempDir, "linkdir");
		const linkedPath = join(linkDir, "outside.ts");
		mkdirSync(realDir);
		writeFileSync(join(realDir, "outside.ts"), "outside\n");
		symlinkSync(realDir, linkDir);

		const result = await executeApplyPatch([
			{ path: linkedPath, action: "update", oldText: "outside", newText: "changed" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(join(realDir, "outside.ts"), "utf8")).toBe("outside\n");
	});

	it("preserves a BOM while matching text after it", async () => {
		writeFileSync(filePath, "\uFEFFhead\nbody\n", "utf8");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "head\nbody", newText: "HEAD\nBODY" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("\uFEFFHEAD\nBODY\n");
	});

	it("rejects invalid UTF-8 instead of rewriting binary bytes", async () => {
		const original = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
		writeFileSync(filePath, original);

		const result = await executeApplyPatch([{ path: filePath, action: "update", oldText: "x", newText: "y" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]?.error).toMatch(/valid UTF-8/);
		expect(readFileSync(filePath)).toEqual(original);
	});

	it("supports multiple disjoint edits against one original file", async () => {
		writeFileSync(filePath, "first();\nsecond();\nthird();\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				edits: [
					{ oldText: "first();", newText: "one();" },
					{ oldText: "third();", newText: "three();" },
				],
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("one();\nsecond();\nthree();\n");
	});

	it("rejects overlapping exact matches instead of applying a partial replacement", async () => {
		writeFileSync(filePath, "aaa\n");

		const result = await executeApplyPatch([{ path: filePath, action: "update", oldText: "aa", newText: "X" }]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("aaa\n");
	});

	it("reports an insertion without false deletion lines", async () => {
		writeFileSync(filePath, "one\ntwo\nthree\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "two\nthree", newText: "two\ninserted\nthree" },
		]);

		expect(result.ok).toBe(true);
		const diff = result.applied[0]?.diff ?? "";
		expect(diff).toContain("+inserted");
		expect(diff).not.toContain("-three");
	});

	it("serializes concurrent updates to the same path", async () => {
		writeFileSync(filePath, "base\n");

		const results = await Promise.all([
			executeApplyPatch([{ path: filePath, action: "update", oldText: "base", newText: "first" }]),
			executeApplyPatch([{ path: filePath, action: "update", oldText: "base", newText: "second" }]),
		]);

		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toHaveLength(1);
		expect(["first\n", "second\n"]).toContain(readFileSync(filePath, "utf8"));
	});

	it("preserves a regular file mode under a restrictive umask", async () => {
		writeFileSync(filePath, "run\n");
		chmodSync(filePath, 0o644);
		const previousUmask = process.umask(0o077);
		try {
			const result = await executeApplyPatch([
				{ path: filePath, action: "update", oldText: "run", newText: "updated" },
			]);
			expect(result.ok).toBe(true);
			expect(statSync(filePath).mode & 0o777).toBe(0o644);
		} finally {
			process.umask(previousUmask);
		}
	});
});
