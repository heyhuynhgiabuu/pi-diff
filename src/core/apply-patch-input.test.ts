import { describe, expect, it } from "vitest";
import { parseApplyPatchInput } from "./apply-patch.js";

describe("parseApplyPatchInput", () => {
	it("accepts the structured single-edit and multi-edit forms", () => {
		expect(
			parseApplyPatchInput({
				changes: [
					{ path: "src/a.ts", action: "update", oldText: "old", newText: "new" },
					{
						path: "src/b.ts",
						action: "update",
						edits: [
							{ oldText: "first", newText: "one" },
							{ oldText: "second", newText: "two" },
						],
					},
				],
			}),
		).toEqual([
			{ path: "src/a.ts", action: "update", oldText: "old", newText: "new" },
			{
				path: "src/b.ts",
				action: "update",
				edits: [
					{ oldText: "first", newText: "one" },
					{ oldText: "second", newText: "two" },
				],
			},
		]);
	});

	it("rejects empty batches and unknown fields", () => {
		expect(() => parseApplyPatchInput({ changes: [] })).toThrow(/at least one change/);
		expect(() => parseApplyPatchInput({ changes: [{ path: "a", action: "delete", extra: true }] })).toThrow(
			/not supported/,
		);
	});

	it("requires action-specific fields", () => {
		expect(() => parseApplyPatchInput({ changes: [{ path: "a", action: "add" }] })).toThrow(/content/);
		expect(() => parseApplyPatchInput({ changes: [{ path: "a", action: "move" }] })).toThrow(/movePath/);
		expect(() => parseApplyPatchInput({ changes: [{ path: "a", action: "update" }] })).toThrow(/oldText/);
		expect(parseApplyPatchInput({ changes: [{ path: "a", action: "update", oldText: "old" }] })).toEqual([
			{ path: "a", action: "update", oldText: "old" },
		]);
		expect(() =>
			parseApplyPatchInput({ changes: [{ path: "a", action: "update", oldText: "old", newText: 42 }] }),
		).toThrow(/newText.*string/);
	});
});
