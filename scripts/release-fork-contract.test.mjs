import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Fork contract: a hummin release never hydrates model data from the pi.dev
// catalog. release.mjs runs the release on import, so the gate is checked in
// its source: every call of upstream's catalog pin step sits behind the opt-in.
test("release.mjs pins the pi.dev model catalog only behind HUMMIN_RELEASE_PIN_MODEL_CATALOG", () => {
	const source = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
	const calls = source.match(/(?<!function )pinAndBuildWithNewestModelCatalog\(\)/g) ?? [];
	const gatedCalls =
		source.match(
			/if \(process\.env\.HUMMIN_RELEASE_PIN_MODEL_CATALOG === "1"\) \{[^}]*pinAndBuildWithNewestModelCatalog\(\)/g,
		) ?? [];
	assert.equal(gatedCalls.length, calls.length);
});
