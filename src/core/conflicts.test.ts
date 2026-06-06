import { describe, expect, it } from "vitest";

import { parseConflicts, hasConflictMarkers, formatConflictSummary } from "./conflicts.js";

describe("parseConflicts", () => {
	it("returns empty result for content without conflicts", () => {
		const result = parseConflicts("hello\nworld\n");
		expect(result.hasConflicts).toBe(false);
		expect(result.regions).toHaveLength(0);
	});

	it("parses a basic 2-way conflict", () => {
		const content = [
			"line1",
			"<<<<<<< HEAD",
			"current change",
			"=======",
			"incoming change",
			">>>>>>> branch",
			"line2",
		].join("\n");

		const result = parseConflicts(content);
		expect(result.hasConflicts).toBe(true);
		expect(result.regions).toHaveLength(1);

		const region = result.regions[0];
		expect(region.currentRef).toBe("HEAD");
		expect(region.current).toEqual(["current change"]);
		expect(region.base).toEqual([]);
		expect(region.incoming).toEqual(["incoming change"]);
		expect(region.incomingRef).toBe("branch");
		expect(region.hasBase).toBe(false);
		expect(region.startLine).toBe(2);
	});

	it("parses a 3-way conflict with base", () => {
		const content = [
			"<<<<<<< HEAD",
			"current",
			"||||||| merged common ancestors",
			"base version",
			"=======",
			"incoming",
			">>>>>>> feature",
		].join("\n");

		const result = parseConflicts(content);
		expect(result.hasConflicts).toBe(true);
		expect(result.regions).toHaveLength(1);

		const region = result.regions[0];
		expect(region.current).toEqual(["current"]);
		expect(region.base).toEqual(["base version"]);
		expect(region.incoming).toEqual(["incoming"]);
		expect(region.hasBase).toBe(true);
	});

	it("parses multi-line conflict regions", () => {
		const content = [
			"<<<<<<< HEAD",
			"line1",
			"line2",
			"=======",
			"lineA",
			"lineB",
			">>>>>>> other",
		].join("\n");

		const result = parseConflicts(content);
		expect(result.regions).toHaveLength(1);
		expect(result.regions[0].current).toHaveLength(2);
		expect(result.regions[0].incoming).toHaveLength(2);
	});

	it("parses multiple conflict regions", () => {
		const content = [
			"<<<<<<< HEAD",
			"one",
			"=======",
			"ONE",
			">>>>>>> branch",
			"",
			"<<<<<<< HEAD",
			"two",
			"=======",
			"TWO",
			">>>>>>> branch",
		].join("\n");

		const result = parseConflicts(content);
		expect(result.regions).toHaveLength(2);
	});

	it("handles conflict markers with no ref name", () => {
		const content = [
			"<<<<<<<",
			"change",
			"=======",
			"other",
			">>>>>>>",
		].join("\n");

		const result = parseConflicts(content);
		expect(result.hasConflicts).toBe(true);
		expect(result.regions[0].currentRef).toBe("");
		expect(result.regions[0].incomingRef).toBe("");
	});

	it("handles empty conflict sides", () => {
		const content = [
			"<<<<<<< HEAD",
			"=======",
			"incoming",
			">>>>>>> branch",
		].join("\n");

		const result = parseConflicts(content);
		expect(result.regions[0].current).toEqual([]);
		expect(result.regions[0].incoming).toEqual(["incoming"]);
	});
});

describe("hasConflictMarkers", () => {
	it("returns true when conflict markers exist", () => {
		expect(hasConflictMarkers("<<<<<<< HEAD\n=======\n>>>>>>> branch")).toBe(true);
	});

	it("returns false when no conflict markers", () => {
		expect(hasConflictMarkers("normal content\n")).toBe(false);
	});

	it("returns false for empty content", () => {
		expect(hasConflictMarkers("")).toBe(false);
	});
});

describe("formatConflictSummary", () => {
	it("formats a 2-way conflict summary", () => {
		const region = {
			currentRef: "HEAD",
			current: ["a"],
			base: [] as string[],
			incoming: ["b"],
			incomingRef: "branch",
			hasBase: false,
			startLine: 1,
		};
		expect(formatConflictSummary(region)).toBe("Conflict: HEAD (1 lines) vs branch (1 lines)");
	});

	it("formats a 3-way conflict summary", () => {
		const region = {
			currentRef: "HEAD",
			current: ["a"],
			base: ["base"],
			incoming: ["b"],
			incomingRef: "branch",
			hasBase: true,
			startLine: 1,
		};
		expect(formatConflictSummary(region)).toContain("[3-way]");
	});
});
