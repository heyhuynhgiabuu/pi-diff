import { describe, expect, it } from "vitest";

import { parsePatchFiles } from "./diff.js";
import { resolveLines, resolveLinesFromPatch } from "./resolve-lines.js";

// ---------------------------------------------------------------------------
// resolveLines — hunk-based match
// ---------------------------------------------------------------------------

describe("resolveLines", () => {
	it("matches existing_code against new-side hunk lines", () => {
		// Diff: change "b" to "B" at line 2
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
		].join("\n");
		const parsed = parsePatchFiles(patch);
		expect(parsed).toHaveLength(1);

		// Match the deleted line "b" via old-side fallback
		const result = resolveLines("b", parsed[0]);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(2);
			expect(result.endLine).toBe(2);
		}
	});

	it("matches multi-line existing_code against new-side", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -5,4 +5,4 @@ function foo() {",
			"     const x = 1;",
			"-    const y = 2;",
			"+    const y = 20;",
			"-    const z = 3;",
			"+    const z = 30;",
			"     return x + y + z;",
		].join("\n");
		const parsed = parsePatchFiles(patch);
		expect(parsed).toHaveLength(1);

		// Match the old-side consecutive del lines
		const result = resolveLines("const y = 2;\nconst z = 3;", parsed[0]);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(6);
			expect(result.endLine).toBe(7);
		}
	});

	it("matches consecutive context lines via new-side", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,4 +1,4 @@",
			" a",
			"-b",
			"+B",
			" c",
			" d",
		].join("\n");
		const parsed = parsePatchFiles(patch);

		// "c" and "d" are consecutive context lines in the new side (lines 3-4)
		const result = resolveLines("c\nd", parsed[0]);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(3);
			expect(result.endLine).toBe(4);
		}
	});

	it("returns unresolved when existing_code doesn't match", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
		].join("\n");
		const parsed = parsePatchFiles(patch);

		const result = resolveLines("this does not exist in the diff", parsed[0]);
		expect(result).toHaveProperty("unresolved", true);
	});

	it("returns unresolved for empty existing_code", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
		].join("\n");
		const parsed = parsePatchFiles(patch);

		expect(resolveLines("", parsed[0])).toHaveProperty("unresolved", true);
		expect(resolveLines("   ", parsed[0])).toHaveProperty("unresolved", true);
	});

	it("returns unresolved when parsed is empty", () => {
		expect(resolveLines("foo", { lines: [], added: 0, removed: 0, chars: 0 })).toHaveProperty("unresolved", true);
	});

	it("is whitespace-tolerant via normalizeLine", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -10,6 +10,6 @@",
			"     const x = 1;",
			"-    log.print('hello')",
			"+    log.print('world')",
		].join("\n");
		const parsed = parsePatchFiles(patch);

		// LLM might return differently-indented code
		const result = resolveLines("  log.print('hello')", parsed[0]);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(11);
			expect(result.endLine).toBe(11);
		}
	});

	it("strips +/- markers from existing_code", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
		].join("\n");
		const parsed = parsePatchFiles(patch);

		// LLM might include diff markers in existing_code
		const result = resolveLines("-b", parsed[0]);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(2);
			expect(result.endLine).toBe(2);
		}
	});

	it("falls back to file content scan when hunk match fails", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
		].join("\n");
		const parsed = parsePatchFiles(patch);
		const fileContent = "a\nB\nc\nd\ne\nf\n";

		// "e" and "f" are in the file but NOT in the diff hunks — should trigger fallback
		const result = resolveLines("e\nf", parsed[0], fileContent);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(5);
			expect(result.endLine).toBe(6);
		}
	});
});

// ---------------------------------------------------------------------------
// resolveLinesFromPatch — unified diff string convenience wrapper
// ---------------------------------------------------------------------------

describe("resolveLinesFromPatch", () => {
	it("parses and resolves from a raw unified diff string", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
		].join("\n");

		const result = resolveLinesFromPatch("b", patch);
		expect(result).not.toHaveProperty("unresolved");
		if (!("unresolved" in result)) {
			expect(result.startLine).toBe(2);
			expect(result.endLine).toBe(2);
		}
	});

	it("returns unresolved for empty patch", () => {
		expect(resolveLinesFromPatch("b", "")).toHaveProperty("unresolved", true);
	});
});
