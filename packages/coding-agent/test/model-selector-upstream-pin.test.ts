import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const LAST_REVIEWED_UPSTREAM_SHA = "df0d88aac";
const PINNED_SHA256 = "5a8566f0cba25e9a23d5236216ec1aaeaf952b290027ef8ec3d0b6f99b0a3c18";

it("model-selector.ts still matches the reviewed upstream copy", () => {
	const file = join(import.meta.dirname, "../src/modes/interactive/components/model-selector.ts");
	const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
	expect(
		actual,
		`upstream changed the shadowed model-selector.ts; review \`git log -p ${LAST_REVIEWED_UPSTREAM_SHA}..upstream/main -- packages/coding-agent/src/modes/interactive/components/model-selector.ts\`, port relevant changes into hummin-model-selector.ts, then update the pinned hash and the last-reviewed upstream sha in this test.`,
	).toBe(PINNED_SHA256);
});
