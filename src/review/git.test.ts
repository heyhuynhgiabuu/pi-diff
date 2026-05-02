import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseUnifiedGitDiff, readGitDiff } from "./git.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 export const a = 1;
-export const b = 2;
+export const b = 3;
+export const c = 4;
 export const d = 5;
diff --git a/src/old.ts b/src/new.ts
similarity index 88%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -10 +10 @@
-oldName();
+newName();
`;

describe("parseUnifiedGitDiff", () => {
	it("parses files, hunks, line numbers, and statuses", () => {
		const files = parseUnifiedGitDiff(SAMPLE);

		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({ path: "src/a.ts", status: "modified" });
		expect(files[0].hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
		expect(files[0].hunks[0].lines).toContainEqual({
			type: "del",
			oldNum: 2,
			newNum: null,
			content: "export const b = 2;",
		});
		expect(files[0].hunks[0].lines).toContainEqual({
			type: "add",
			oldNum: null,
			newNum: 3,
			content: "export const c = 4;",
		});
		expect(files[1]).toMatchObject({
			oldPath: "src/old.ts",
			newPath: "src/new.ts",
			path: "src/new.ts",
			status: "renamed",
		});
	});
});

describe("readGitDiff", () => {
	it("includes untracked files in working-tree mode", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
		execFileSync("git", ["init"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
		execFileSync("git", ["add", ".gitignore"], { cwd });
		execFileSync("git", ["commit", "-m", "init"], { cwd });

		writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
		writeFileSync(join(cwd, "ignored.txt"), "ignored\n");

		const diff = readGitDiff(cwd);

		expect(diff.files).toHaveLength(1);
		expect(diff.files[0]).toMatchObject({ path: "new.ts", status: "added" });
		expect(diff.files[0].hunks[0].lines).toContainEqual({
			type: "add",
			oldNum: null,
			newNum: 1,
			content: "export const added = true;",
		});
	});
});
