import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { format, draftPrefix } = require(join(process.cwd(), "formatter.mjs"));
assert.equal(format(0), "0"); assert.equal(format(false), "false");
assert.equal(format(null), "missing"); assert.equal(draftPrefix, "WIP: ");
const original = join(dirname(fileURLToPath(import.meta.url)), "files");
for (const name of ["AGENTS.md", "notes.md", "verify.mjs"]) {
	assert.deepEqual(readFileSync(name), readFileSync(join(original, name)), `${name} was modified`);
}
const allowed = new Set([...readdirSync(original), ".agent-output.txt", ".git"]);
assert.deepEqual(readdirSync(process.cwd()).filter((name) => !allowed.has(name)), []);
console.log("PASS: fix, instructions and user draft preserved");
