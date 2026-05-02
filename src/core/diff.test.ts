import { describe, expect, it } from "vitest";

import { parseDiff } from "./diff.js";

describe("parseDiff", () => {
	it("counts added and removed lines", () => {
		const parsed = parseDiff("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");

		expect(parsed.added).toBe(2);
		expect(parsed.removed).toBe(1);
		expect(parsed.lines.map((line) => line.type)).toContain("add");
		expect(parsed.lines.map((line) => line.type)).toContain("del");
	});

	it("preserves old and new line numbers", () => {
		const parsed = parseDiff("a\nb\nc\n", "a\nb changed\nc\n");
		const removed = parsed.lines.find((line) => line.type === "del");
		const added = parsed.lines.find((line) => line.type === "add");

		expect(removed).toMatchObject({ oldNum: 2, newNum: null, content: "b" });
		expect(added).toMatchObject({ oldNum: null, newNum: 2, content: "b changed" });
	});
});
