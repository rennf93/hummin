import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const LAST_REVIEWED_UPSTREAM_SHA = "e7a0df27c";
const PINNED_SHA256 = "5a06d8a689b32bb9779422c6b03351cf5878da5fbb4646fe6622e451ac81d41c";

it("model-selector.ts still matches the reviewed upstream copy", () => {
	const file = join(import.meta.dirname, "../src/modes/interactive/components/model-selector.ts");
	const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
	expect(
		actual,
		`upstream changed the shadowed model-selector.ts; review \`git log -p ${LAST_REVIEWED_UPSTREAM_SHA}..upstream/main -- packages/coding-agent/src/modes/interactive/components/model-selector.ts\`, port relevant changes into hummin-model-selector.ts, then update the pinned hash and the last-reviewed upstream sha in this test.`,
	).toBe(PINNED_SHA256);
});
