import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const LAST_REVIEWED_UPSTREAM_SHA = "4954d7605";
const PINNED_SHA256 = "33f09f1060b44bfb4cddb31e9fae84371079d15e731a6391c388da6ce2c6e4a4";

it("model-selector.ts still matches the reviewed upstream copy", () => {
	const file = join(import.meta.dirname, "../src/modes/interactive/components/model-selector.ts");
	const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
	expect(
		actual,
		`upstream changed the shadowed model-selector.ts; review \`git log -p ${LAST_REVIEWED_UPSTREAM_SHA}..upstream/main -- packages/coding-agent/src/modes/interactive/components/model-selector.ts\`, port relevant changes into hummin-model-selector.ts, then update the pinned hash and the last-reviewed upstream sha in this test.`,
	).toBe(PINNED_SHA256);
});
