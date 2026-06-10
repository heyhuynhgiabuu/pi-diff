import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replace } from "./replace.js";

describe("replace", () => {
	// -----------------------------------------------------------------------
	// Simple exact match
	// -----------------------------------------------------------------------

	describe("simple exact match", () => {
		it("replaces exact text", () => {
			const result = replace("hello world", "world", "there");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("hello there");
			expect(result.strategy).toBe("simple");
			expect(result.count).toBe(1);
		});

		it("returns unchanged when oldString not found", () => {
			const result = replace("hello world", "nope", "there");
			expect(result.changed).toBe(false);
			expect(result.content).toBe("hello world");
			expect(result.strategy).toBe("none");
		});

		it("rejects empty oldString", () => {
			const result = replace("hello", "", "world");
			expect(result.changed).toBe(false);
		});

		it("rejects identical old and new strings", () => {
			const result = replace("hello", "hello", "hello");
			expect(result.changed).toBe(false);
		});

		it("rejects multiple occurrences without replaceAll", () => {
			const result = replace("foo bar foo", "foo", "baz");
			expect(result.changed).toBe(false);
			expect(result.content).toBe("foo bar foo");
		});

		it("replaces all with replaceAll", () => {
			const result = replace("foo bar foo baz foo", "foo", "qux", { replaceAll: true });
			expect(result.changed).toBe(true);
			expect(result.content).toBe("qux bar qux baz qux");
			expect(result.strategy).toBe("simple-replaceAll");
			expect(result.count).toBe(3);
		});
	});

	// -----------------------------------------------------------------------
	// Line-trimmed match
	// -----------------------------------------------------------------------

	describe("line-trimmed match", () => {
		it("matches multi-line blocks with different indentation", () => {
			const content = "function foo() {\n    const x = 1;\n    return x;\n}";
			const oldStr = "  const x = 1;\n  return x;";
			const result = replace(content, oldStr, "  const y = 2;\n  return y;");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("line-trimmed");
			expect(result.content).toBe("function foo() {\n  const y = 2;\n  return y;\n}");
		});

		it("matches single-line when exact match is inside larger whitespace", () => {
			const content = "one\n  two  \nthree";
			const result = replace(content, "two", "TWO");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("one\n  TWO  \nthree");
		});

		it("rejects when trimmed lines don't match", () => {
			const content = "hello\nworld\n";
			const result = replace(content, "nope\nnever", "gone");
			expect(result.changed).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Block anchor match
	// -----------------------------------------------------------------------

	describe("block anchor match", () => {
		it("matches blocks with minor middle-line differences", () => {
			const content = [
				"function oldFunc() {",
				'  console.log("hello");',
				'  console.log("world");',
				"  return 42;",
				"}",
			].join("\n");
			const oldStr = [
				"function oldFunc() {",
				'  console.log("hello");',
				'  console.log("world");',
				"  return 99;",
				"}",
			].join("\n");
			const newStr = ["function newFunc() {", '  console.log("hi");', "}"].join("\n");

			const result = replace(content, oldStr, newStr);
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("block-anchor");
			expect(result.content.split("\n")[0]).toBe("function newFunc() {");
		});

		it("skips single-line and two-line blocks", () => {
			const result = replace("a\nb", "a\nb", "x\ny");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("simple");
		});

		it("rejects when content anchor not found", () => {
			const content = ["function foo() {", "  totally", "  different", "  stuff here", "}"].join("\n");
			const oldStr = ["function foo() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}"].join("\n");

			const result = replace(content, oldStr, "GONE");
			expect(result.changed).toBe(false);
		});

		it("rejects when similarity threshold not met", () => {
			const content = ["function foo() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}"].join("\n");
			const oldStr = ["function foo() {", "  xxxxxxxxxxxxx", "  yyyyyyyyyyyyy", "  zzzzzzzzzzzzz", "}"].join("\n");

			const result = replace(content, oldStr, "GONE");
			expect(result.changed).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Whitespace-normalized match
	// -----------------------------------------------------------------------

	describe("whitespace-normalized match", () => {
		it("matches with different whitespace", () => {
			const content = "hello   world";
			const oldStr = "hello world";
			const result = replace(content, oldStr, "hi there");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("whitespace-normalized");
			expect(result.content).toBe("hi there");
		});

		it("matches multi-line with irregular whitespace", () => {
			const content = "a\nb   c\nd";
			const result = replace(content, "b c", "B C");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("whitespace-normalized");
			expect(result.content).toBe("a\nB C\nd");
		});
	});

	// -----------------------------------------------------------------------
	// Escape-normalized match
	// -----------------------------------------------------------------------

	describe("escape-normalized match", () => {
		it("unescapes \\n in oldString", () => {
			const content = "line1\nline2\nline3";
			const oldStr = "line1\\nline2";
			const result = replace(content, oldStr, "X");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("escape-normalized");
			expect(result.content).toBe("X\nline3");
		});

		it("unescapes \\t in oldString", () => {
			const content = "tabbed\ttext";
			const oldStr = "tabbed\\ttext";
			const result = replace(content, oldStr, "TABBED TEXT");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("escape-normalized");
			expect(result.content).toBe("TABBED TEXT");
		});

		it("does nothing when no escape sequences present", () => {
			const result = replace("hello", "hello", "world");
			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("simple");
		});
	});

	// -----------------------------------------------------------------------
	// Trimmed-boundary match
	// -----------------------------------------------------------------------

	describe("trimmed-boundary match", () => {
		it("matches with leading/trailing whitespace in oldString", () => {
			const content = "const x = 1;";
			const oldStr = "  const x = 1;  ";
			const result = replace(content, oldStr, "const y = 2;");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("const y = 2;");
		});

		it("triggers with multi-line trailing whitespace", () => {
			const content = "hello world\nmore text";
			const oldStr = "hello world  \nmore text  ";
			const result = replace(content, oldStr, "REPLACED");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("REPLACED");
		});
	});

	// -----------------------------------------------------------------------
	// Multi-occurrence replaceAll
	// -----------------------------------------------------------------------

	describe("replaceAll", () => {
		it("replaces all exact occurrences", () => {
			const result = replace("  DEBUG: hello\n  DEBUG: world", "DEBUG:", "INFO:", { replaceAll: true });
			expect(result.changed).toBe(true);
			expect(result.content).toBe("  INFO: hello\n  INFO: world");
		});

		it("replaces all with line-trimmed fallback", () => {
			const content = "DEBUG: hello\nDEBUG: world";
			const oldStr = "  DEBUG:";
			const result = replace(content, oldStr, "INFO:", { replaceAll: true });
			expect(result.changed).toBe(true);
			expect(result.content).toBe("INFO: hello\nINFO: world");
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------

	describe("edge cases", () => {
		it("handles empty content", () => {
			const result = replace("", "old", "new");
			expect(result.changed).toBe(false);
		});

		it("handles newline at end of file", () => {
			const result = replace("line1\nline2\n", "line2", "LINE2");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("line1\nLINE2\n");
		});

		it("handles replacement with empty string", () => {
			const result = replace("hello world", "world", "");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("hello ");
		});

		it("handles content with CRLF", () => {
			const result = replace("line1\r\nline2\r\nline3", "line2", "LINE2");
			expect(result.changed).toBe(true);
			expect(result.content).toBe("line1\r\nLINE2\r\nline3");
		});

		it("rejects edit when duplicate text exists without replaceAll", () => {
			const content = "dup\nmiddle\ndup";
			const result = replace(content, "dup", "DUP");
			expect(result.changed).toBe(false);
			expect(result.content).toBe("dup\nmiddle\ndup");
		});

		it("handles large content with replaceAll", () => {
			const line = "x".repeat(10);
			const content = Array.from({ length: 100 }, () => line).join("\n");
			const result = replace(content, line, "y".repeat(10), { replaceAll: true });
			expect(result.changed).toBe(true);
			expect(result.count).toBe(100);
			expect(result.content.split("\n").every((l) => l === "y".repeat(10))).toBe(true);
		});
	});
});

// -----------------------------------------------------------------------
// Integration: edit-tool flow simulation (replace → write → verify)
// -----------------------------------------------------------------------

describe("replace integration: edit-tool flow", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "replace-int-"));
		filePath = join(tempDir, "test.ts");
		writeFileSync(filePath, 'function greet() {\n    console.log("hello");\n    return 42;\n}');
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("replaces with exact match (like edit tool with exact oldText)", () => {
		const content = readFileSync(filePath, "utf-8");
		const result = replace(content, '    console.log("hello");', '    console.log("hi");');
		expect(result.changed).toBe(true);
		expect(result.strategy).toBe("simple");

		// Write result (simulating edit tool)
		writeFileSync(filePath, result.content);

		const final = readFileSync(filePath, "utf-8");
		expect(final).toContain('console.log("hi")');
		expect(final).not.toContain('console.log("hello")');
	});

	it("replaces with line-trimmed match (multi-line indentation drift)", () => {
		const content = readFileSync(filePath, "utf-8");
		// oldText has different indentation on INNER lines only — outer line
		// indent differs so SimpleReplacer can't substring-match
		const oldStr = '  function greet() {\n    console.log("hello");';
		const result = replace(content, oldStr, 'function newFunc() {\n    console.log("hi");');
		expect(result.changed).toBe(true);
		expect(result.strategy).toBe("line-trimmed");

		writeFileSync(filePath, result.content);
		const final = readFileSync(filePath, "utf-8");
		expect(final).toContain("function newFunc()");
	});

	it("replaces with block-anchor match (small line differences)", () => {
		writeFileSync(
			filePath,
			["function oldFunc() {", '  console.log("a");', '  console.log("b");', "  return 42;", "}"].join("\n"),
		);

		const content = readFileSync(filePath, "utf-8");
		// oldText has slightly different lines from actual content
		const oldStr = [
			"function oldFunc() {",
			'  console.log("a");',
			'  console.log("b");',
			"  return 99;", // <-- different from "return 42;"
			"}",
		].join("\n");
		const newStr = ["function newFunc() {", '  console.log("x");', "}"].join("\n");

		const result = replace(content, oldStr, newStr);
		expect(result.changed).toBe(true);
		expect(result.strategy).toBe("block-anchor");

		writeFileSync(filePath, result.content);
		const final = readFileSync(filePath, "utf-8");
		expect(final).toContain("function newFunc()");
	});

	it("replaces with escape-normalized match (LLM-escaped oldText)", () => {
		const content = readFileSync(filePath, "utf-8");
		// LLM escapes \n in tool call
		const result = replace(
			content,
			'function greet() {\\n    console.log("hello");',
			'function greet() {\n    console.log("hi");',
		);
		expect(result.changed).toBe(true);
		expect(result.strategy).toBe("escape-normalized");

		writeFileSync(filePath, result.content);
		const final = readFileSync(filePath, "utf-8");
		expect(final).toContain('console.log("hi")');
	});

	it("replaces successfully regardless of which strategy fires first", () => {
		const content = readFileSync(filePath, "utf-8");
		// Let the cascade figure out the strategy — the key assertion is
		// the replacement is applied to the file
		const result = replace(content, "  function greet() {", "function newFunc() {");
		expect(result.changed).toBe(true);

		writeFileSync(filePath, result.content);
		const final = readFileSync(filePath, "utf-8");
		expect(final).toContain("function newFunc()");
	});

	it("falls through (no match) when oldText doesn't resemble content", () => {
		const content = readFileSync(filePath, "utf-8");
		const result = replace(content, "something completely different", "new content");
		expect(result.changed).toBe(false);
		expect(result.strategy).toBe("none");
	});
});
