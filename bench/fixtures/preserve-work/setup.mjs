import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// This disposable fixture has a staged baseline plus an unstaged user draft.
// No commits, resets, or operations on the developer's repository.
const draft = readFileSync("notes.md");
writeFileSync("notes.md", "# Original draft\n");
for (const args of [["init", "--quiet"], ["add", "AGENTS.md", "notes.md", "formatter.mjs", "verify.mjs"]]) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}
writeFileSync("notes.md", draft);
