import { describe, expect, it } from "vitest";
import { countDiffStat } from "../src/modes/interactive/components/diff.ts";

describe("countDiffStat", () => {
	it("counts added and removed lines in the display diff format", () => {
		const diff = [
			" 1 unchanged",
			"-2 removed line",
			"-3 removed line",
			" 4 ...",
			"+5 added line",
			" 6 unchanged",
			"",
		].join("\n");
		expect(countDiffStat(diff)).toEqual({ added: 1, removed: 2 });
	});

	it("skips unified patch file headers", () => {
		const patch = [
			"diff --git a/foo.ts b/foo.ts",
			"--- a/foo.ts",
			"+++ b/foo.ts",
			"@@ -1,3 +1,3 @@",
			"-old",
			"+new",
			" context",
			"",
		].join("\n");
		expect(countDiffStat(patch)).toEqual({ added: 1, removed: 1 });
	});

	it("counts a new-file write as all added", () => {
		const patch = ["--- /dev/null", "+++ b/new.ts", "+line 1", "+line 2", ""].join("\n");
		expect(countDiffStat(patch)).toEqual({ added: 2, removed: 0 });
	});

	it("returns zeros for an empty diff", () => {
		expect(countDiffStat("")).toEqual({ added: 0, removed: 0 });
	});
});
