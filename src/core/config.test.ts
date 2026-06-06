import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidatePiDiffConfig, loadPiDiffConfig, configSepStyle, configLineNumbers, configIndicatorStyle, configLongLines, configFileHeader, configColors } from "./config.js";

describe("loadPiDiffConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-diff-config-test-"));
		invalidatePiDiffConfig();
	});

	afterEach(() => {
		invalidatePiDiffConfig();
	});

	it("returns empty object when no config file exists", () => {
		const config = loadPiDiffConfig(tmpDir);
		expect(config).toEqual({});
	});

	it("reads from project-level pi-diff.json", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false, indicatorStyle: "none" }), "utf-8");

		const config = loadPiDiffConfig(tmpDir);
		expect(config.lineNumbers).toBe(false);
		expect(config.indicatorStyle).toBe("none");
	});

	it("reads sepStyle from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ sepStyle: "metadata" }), "utf-8");

		expect(configSepStyle(tmpDir)).toBe("metadata");
	});

	it("reads longLines from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ longLines: "scroll" }), "utf-8");

		expect(configLongLines(tmpDir)).toBe("scroll");
	});

	it("reads fileHeader from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ fileHeader: false }), "utf-8");

		expect(configFileHeader(tmpDir)).toBe(false);
	});

	it("reads color overrides from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				colors: { bgAdd: "#111111", bgDel: "#222222", fgAdd: "#33ff33" },
			}),
			"utf-8",
		);

		const colors = configColors(tmpDir);
		expect(colors?.bgAdd).toBe("#111111");
		expect(colors?.bgDel).toBe("#222222");
		expect(colors?.fgAdd).toBe("#33ff33");
	});

	it("ignores invalid JSON files silently", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, "not valid json", "utf-8");

		const config = loadPiDiffConfig(tmpDir);
		expect(config).toEqual({});
	});

	it("caches the result across calls", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false }), "utf-8");

		const first = loadPiDiffConfig(tmpDir);
		expect(first.lineNumbers).toBe(false);

		// Modify file
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");

		// Without invalidation, should still return cached value
		const second = loadPiDiffConfig(tmpDir);
		expect(second.lineNumbers).toBe(false);
	});

	it("re-reads after invalidation", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false }), "utf-8");

		loadPiDiffConfig(tmpDir);
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");

		invalidatePiDiffConfig();
		const config = loadPiDiffConfig(tmpDir);
		expect(config.lineNumbers).toBe(true);
	});
});
