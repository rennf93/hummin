import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Fork contract: hummin-cli pins upstream @earendil-works/* packages to one exact
// release. stage-hummin-cli.mjs stages on import, so the pin is checked in its source.
const source = readFileSync(new URL("./stage-hummin-cli.mjs", import.meta.url), "utf8");

test("stage-hummin-cli.mjs pins UPSTREAM_VERSION to an exact x.y.z", () => {
	const match = source.match(/const\s+UPSTREAM_VERSION\s*=\s*(["'])([^"']*)\1/);
	assert.ok(match, "UPSTREAM_VERSION literal not found");
	assert.match(match[2], /^\d+\.\d+\.\d+$/);
});

test("stage-hummin-cli.mjs keeps its exact-version self-check and never turns the pin into a range", () => {
	assert.match(source, /\.test\(\s*UPSTREAM_VERSION\s*\)\s*\)\s*throw/);
	assert.doesNotMatch(source, /[\^~]\$\{UPSTREAM_VERSION\}/);
	assert.doesNotMatch(source, /["'`][\^~]["'`]\s*\+\s*UPSTREAM_VERSION/);
});
