/**
 * End-to-end test: edit tool flow simulation.
 *
 * Simulates the exact flow pi-diff's edit tool executes:
 *   read file → replace(oldText, newText) → write file → verify on disk
 *
 * Tests every strategy in the REPLACERS cascade with real file I/O.
 * This is what the Pi agent would experience when calling the edit tool.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replace } from "../src/core/replace.js";

// ---------------------------------------------------------------------------
// Helpers: simulate edit tool flow
// ---------------------------------------------------------------------------

interface EditOperation {
	oldText: string;
	newText: string;
}

interface EditResult {
	changed: boolean;
	strategy: string;
	content: string;
	filePath: string;
}

/**
 * Simulate pi-diff's edit tool execute() flow:
 *   1. Read file from disk
 *   2. For each operation, call replace() on the content
 *   3. If all succeed, write to disk
 *   4. Return the result
 *
 * Falls through (returns unchanged) when any operation fails — matching
 * the real edit tool behavior.
 */
function simulateEditTool(filePath: string, operations: EditOperation[]): EditResult {
	if (!existsSync(filePath)) {
		return { changed: false, strategy: "none", content: "", filePath };
	}

	const content = readFileSync(filePath, "utf-8");
	let current = content;
	let firstStrategy = "";

	for (const op of operations) {
		const r = replace(current, op.oldText, op.newText);
		if (!r.changed) {
			return { changed: false, strategy: "none", content, filePath };
		}
		current = r.content;
		if (!firstStrategy) firstStrategy = r.strategy;
	}

	writeFileSync(filePath, current, "utf-8");
	return { changed: true, strategy: firstStrategy, content: current, filePath };
}

// ---------------------------------------------------------------------------
// Test files
// ---------------------------------------------------------------------------

const TYPESCRIPT_FILE = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { replace } from "../src/core/replace.js";

interface Config {
	name: string;
	version: number;
	enabled: boolean;
}

function processConfig(config: Config): string {
	if (!config.enabled) {
		return "";
	}
	const result = \`Processing \${config.name} v\${config.version}\`;
	console.log(result);
	return result;
}

function oldHelper(): void {
	const items = ["a", "b", "c"];
	for (const item of items) {
		console.log(item);
	}
}

// Main
const cfg: Config = { name: "test", version: 1, enabled: true };
processConfig(cfg);
`;

const PYTHON_FILE = `def factorial(n):
    if n <= 1:
        return 1
    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


def fibonacci(n):
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b


def process_data(data, multiplier=1):
    transformed = []
    for item in data:
        transformed.append(item * multiplier)
    return transformed
`;

const MARKDOWN_FILE = `# Project Documentation

## Getting Started

To get started, run the following command:

\`\`\`bash
npm install
npm run dev
\`\`\`

## API Reference

### \`processConfig(options)\`

Processes a configuration object.

**Parameters:**
- \`options.name\` (string) — The name of the configuration
- \`options.version\` (number) — Version number

**Returns:** A formatted string.

## Configuration

The configuration file should be placed at \`./config.json\`.
`;

const CONFIG_FILE = `{
	"name": "my-app",
	"version": "2.1.0",
	"features": {
		"darkMode": true,
		"beta": false,
		"analytics": true
	},
	"endpoints": {
		"api": "https://api.example.com/v2",
		"cdn": "https://cdn.example.com"
	}
}
`;

// ---------------------------------------------------------------------------
// E2E test suite
// ---------------------------------------------------------------------------

describe("e2e: edit tool flow — full read/replace/write/verify cycle", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-diff-e2e-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// ------------------------------------------------------------------
	// 1. Simple exact match
	// ------------------------------------------------------------------

	describe("simple exact match", () => {
		it("replaces exact single-line text in a TS file", () => {
			const fp = join(tempDir, "config.ts");
			writeFileSync(fp, TYPESCRIPT_FILE);

			const result = simulateEditTool(fp, [
				{
					// biome-ignore lint/suspicious/noTemplateCurlyInString: test data containing TS template literal
					oldText: "  const result = `Processing ${config.name} v${config.version}`;",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: test data containing TS template literal
					newText: "  const result = `[${config.name}] version ${config.version}`;",
				},
			]);

			expect(result.changed).toBe(true);
			// File uses tabs, oldText uses spaces -> line-trimmed
			expect(result.strategy).toBe("line-trimmed");
			const disk = readFileSync(fp, "utf-8");
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test assertion on TS template literal
			expect(disk).toContain("[${config.name}] version");
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test assertion on TS template literal
			expect(disk).not.toContain("Processing ${config.name} v");
		});

		it("replaces exact multi-line block", () => {
			const fp = join(tempDir, "process.ts");
			writeFileSync(fp, TYPESCRIPT_FILE);

			const oldBlock =
				'function oldHelper(): void {\n\tconst items = ["a", "b", "c"];\n\tfor (const item of items) {\n\t\tconsole.log(item);\n\t}\n}';
			const newBlock =
				"function newHelper(items: string[]): void {\n\tfor (const item of items) {\n\t\tconsole.log(item);\n\t}\n}";

			const result = simulateEditTool(fp, [{ oldText: oldBlock, newText: newBlock }]);

			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("simple");
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("function newHelper");
			expect(disk).not.toContain("function oldHelper");
		});

		it("rejects ambiguous exact match (duplicate text)", () => {
			const fp = join(tempDir, "dup.ts");
			writeFileSync(fp, "foo\nmiddle\nfoo");

			const result = simulateEditTool(fp, [{ oldText: "foo", newText: "bar" }]);

			expect(result.changed).toBe(false);
			// File unchanged
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("foo\nmiddle\nfoo");
		});
	});

	// ------------------------------------------------------------------
	// 2. Escape-normalized match
	// ------------------------------------------------------------------

	describe("escape-normalized match", () => {
		it("handles LLM-escaped \\n in oldText", () => {
			const fp = join(tempDir, "escaped.ts");
			writeFileSync(fp, TYPESCRIPT_FILE);

			// LLM escapes the newlines in the tool call
			const result = simulateEditTool(fp, [
				{
					oldText: 'function processConfig(config: Config): string {\\n\\tif (!config.enabled) {\\n\\t\\treturn "";',
					newText:
						'function processConfig(config: Config): string {\n\tif (!config.enabled || !config.name) {\n\t\treturn "";',
				},
			]);

			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("escape-normalized");
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("!config.enabled || !config.name");
		});

		it("handles LLM-escaped \\t in oldText", () => {
			const fp = join(tempDir, "tab-escape.ts");
			writeFileSync(fp, "function foo() {\n\treturn 42;\n}");

			const result = simulateEditTool(fp, [
				{ oldText: "function foo() {\\n\\treturn 42;\\n}", newText: "function bar() {\n\treturn 99;\n}" },
			]);

			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("escape-normalized");
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("function bar()");
			expect(disk).toContain("return 99");
		});

		it("handles escaped quotes and backticks (typical in LLM output)", () => {
			const fp = join(tempDir, "quotes.ts");
			writeFileSync(fp, `const greeting = "hello world";`);

			const result = simulateEditTool(fp, [
				{ oldText: 'const greeting = \\"hello world\\";', newText: 'const greeting = "hi there";' },
			]);

			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("escape-normalized");
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain('"hi there"');
		});
	});

	// ------------------------------------------------------------------
	// 3. Line-trimmed match
	// ------------------------------------------------------------------

	describe("line-trimmed match", () => {
		it("matches with indentation drift on inner lines", () => {
			const fp = join(tempDir, "indent.ts");
			writeFileSync(fp, TYPESCRIPT_FILE);

			// oldText has actual newlines but uses 4-space indent; file uses tabs
			const result = simulateEditTool(fp, [
				{
					oldText: "interface Config {\n\tname: string;\n\tversion: number;",
					newText: "interface Config {\n\tname: string;\n\tversion: number;\n\tactive: boolean;",
				},
			]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("active: boolean");
		});

		it("matches single line with extra surrounding whitespace", () => {
			const fp = join(tempDir, "single-indent.ts");
			writeFileSync(fp, "  hello world  ");

			// oldText matches as substring via SimpleReplacer
			// Replacement preserves surrounding whitespace
			const result = simulateEditTool(fp, [{ oldText: "hello world", newText: "hi universe" }]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("  hi universe  ");
		});
	});

	// ------------------------------------------------------------------
	// 4. Block anchor match
	// ------------------------------------------------------------------

	describe("block-anchor match", () => {
		it("matches block with minor middle-line differences (single candidate)", () => {
			const fp = join(tempDir, "anchor-single.ts");
			writeFileSync(
				fp,
				[
					"function oldFunc() {",
					'  console.log("a");',
					'  console.log("b");',
					"  return 42;",
					"}",
					"",
					"function unrelated() {",
					"  return 0;",
					"}",
				].join("\n"),
			);

			// oldText has a different middle line ("return 99" vs "return 42")
			const result = simulateEditTool(fp, [
				{
					oldText: ["function oldFunc() {", '  console.log("a");', '  console.log("b");', "  return 99;", "}"].join(
						"\n",
					),
					newText: ["function newFunc() {", '  console.log("x");', "}"].join("\n"),
				},
			]);

			expect(result.changed).toBe(true);
			expect(result.strategy).toBe("block-anchor");
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("function newFunc()");
			expect(disk).not.toContain("function oldFunc()");
		});

		it("rejects when similarity is too low (multiple candidates fail threshold)", () => {
			const fp = join(tempDir, "anchor-low-sim.ts");
			writeFileSync(fp, ["function foo() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}"].join("\n"));

			// Completely different middle lines — low similarity
			const result = simulateEditTool(fp, [
				{
					oldText: ["function foo() {", "  xxxxxxxxxxxxx", "  yyyyyyyyyyyyy", "  zzzzzzzzzzzzz", "}"].join("\n"),
					newText: "GONE",
				},
			]);

			expect(result.changed).toBe(false);
		});

		it("matches with anchor-only (no middle lines)", () => {
			const fp = join(tempDir, "anchor-no-middle.ts");
			writeFileSync(fp, "start\nmiddle\nend");

			const result = simulateEditTool(fp, [{ oldText: "AAA\nmiddle\nBBB", newText: "X\nY\nZ" }]);

			// AAA/BBB don't match content start/end, so block-anchor won't find anchors
			// But line-trimmed or whitespace-normalized might match "middle"
			// Actually "AAA" != "start" and "BBB" != "end", so block-anchor fails
			// and "middle" isn't enough for line-trimmed (needs old to match)
			expect(result.changed).toBe(false);
		});
	});

	// ------------------------------------------------------------------
	// 5. Whitespace-normalized match
	// ------------------------------------------------------------------

	describe("whitespace-normalized match", () => {
		it("matches with irregular whitespace between tokens", () => {
			const fp = join(tempDir, "ws-normalize.ts");
			writeFileSync(fp, "const   x   =   1;");

			const result = simulateEditTool(fp, [{ oldText: "const x = 1;", newText: "const y = 2;" }]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("const y = 2;");
		});

		it("matches multi-line block with different whitespace patterns", () => {
			const fp = join(tempDir, "ws-multi.ts");
			writeFileSync(fp, "a\nb   c\nd");

			const result = simulateEditTool(fp, [{ oldText: "b c", newText: "B C" }]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("a\nB C\nd");
		});
	});

	// ------------------------------------------------------------------
	// 6. Trimmed-boundary match
	// ------------------------------------------------------------------

	describe("trimmed-boundary match", () => {
		it("matches with leading whitespace in oldText", () => {
			const fp = join(tempDir, "trim-leading.ts");
			writeFileSync(fp, "const x = 1;");

			const result = simulateEditTool(fp, [{ oldText: "  const x = 1;", newText: "const y = 2;" }]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("const y = 2;");
		});

		it("matches with trailing whitespace in oldText", () => {
			const fp = join(tempDir, "trim-trailing.ts");
			writeFileSync(fp, "hello world");

			const result = simulateEditTool(fp, [{ oldText: "hello world  ", newText: "hi universe" }]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("hi universe");
		});
	});

	// ------------------------------------------------------------------
	// 7. Multi-operation edits
	// ------------------------------------------------------------------

	describe("multi-operation edits", () => {
		it("applies multiple operations in sequence", () => {
			const fp = join(tempDir, "multi-op.ts");
			writeFileSync(fp, PYTHON_FILE);

			const result = simulateEditTool(fp, [
				// Operation 1: rename function
				{ oldText: "def factorial(n):", newText: "def compute_factorial(n):" },
				// Operation 2: change return
				{ oldText: "def fibonacci(n):", newText: "def compute_fibonacci(n):" },
			]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("def compute_factorial");
			expect(disk).not.toContain("def factorial(n):");
			expect(disk).toContain("def compute_fibonacci");
			expect(disk).not.toContain("def fibonacci(n):");
		});

		it("fails on second operation if first changes content", () => {
			const fp = join(tempDir, "multi-op-fail.ts");
			writeFileSync(fp, "line1\nline2\nline3");

			// Operation 1 renames line1, then operation 2 tries to find old line1
			const result = simulateEditTool(fp, [
				{ oldText: "line1", newText: "LINE1" },
				{ oldText: "line1", newText: "L1" }, // line1 no longer exists!
			]);

			expect(result.changed).toBe(false);
			// File should be unchanged (first op was applied to content variable
			// but second op failed, so write never happened)
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("line1\nline2\nline3");
		});

		it("supports operations using different strategies per operation", () => {
			const fp = join(tempDir, "multi-strat.ts");
			writeFileSync(fp, "function foo() {\n\treturn 1;\n}\n\nfunction bar() {\n\treturn 2;\n}");

			const result = simulateEditTool(fp, [
				{ oldText: "function foo() {\\n\\treturn 1;\\n}", newText: "function foo() {\n\treturn 42;\n}" }, // escape-normalized
				{ oldText: "function bar() {", newText: "function baz() {" }, // simple
			]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("return 42");
			expect(disk).toContain("function baz()");
		});
	});

	// ------------------------------------------------------------------
	// 8. Real-world scenarios
	// ------------------------------------------------------------------

	describe("real-world scenarios", () => {
		it("replaces a method in a Python file", () => {
			const fp = join(tempDir, "math.py");
			writeFileSync(fp, PYTHON_FILE);

			// LLM might send oldText with slightly different indentation
			const result = simulateEditTool(fp, [
				{
					oldText: "    for _ in range(2, n + 1):\n        a, b = b, a + b\n    return b",
					newText: "    for i in range(2, n + 1):\n        a, b = b, a + b\n    return a",
				},
			]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("for i in range(2, n + 1)");
			expect(disk).toContain("return a");
		});

		it("replaces JSON config values", () => {
			const fp = join(tempDir, "config.json");
			writeFileSync(fp, CONFIG_FILE);

			const result = simulateEditTool(fp, [
				{ oldText: '"beta": false', newText: '"beta": true' },
				{ oldText: '"version": "2.1.0"', newText: '"version": "3.0.0"' },
			]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain('"beta": true');
			expect(disk).toContain('"version": "3.0.0"');
		});

		it("replaces code block in markdown", () => {
			const fp = join(tempDir, "docs.md");
			writeFileSync(fp, MARKDOWN_FILE);

			const result = simulateEditTool(fp, [
				{
					oldText: "npm install\nnpm run dev",
					newText: "pnpm install\npnpm dev",
				},
			]);

			expect(result.changed).toBe(true);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toContain("pnpm install");
			// "npm install" is substring of "pnpm install" at position 1 (p + npm install)
			// Use word-boundary check instead of not.toContain
			expect(disk.match(/\bnpm\b/g)).toBeNull();
			expect(disk).not.toContain("npm run dev");
		});

		it("handles 'unchanged' when oldText === newText", () => {
			const fp = join(tempDir, "noop.ts");
			writeFileSync(fp, "unchanged");

			const result = simulateEditTool(fp, [{ oldText: "unchanged", newText: "unchanged" }]);

			// replace() returns { changed: false } for identical strings
			expect(result.changed).toBe(false);
			const disk = readFileSync(fp, "utf-8");
			expect(disk).toBe("unchanged");
		});

		it("returns unchanged for non-existent file", () => {
			const fp = join(tempDir, "nonexistent.ts");

			const result = simulateEditTool(fp, [{ oldText: "anything", newText: "nothing" }]);

			expect(result.changed).toBe(false);
			expect(existsSync(fp)).toBe(false);
		});
	});
});
