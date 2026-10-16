import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// footer.ts is shadowed by hummin-footer.ts (its upstream render body is unreachable), so upstream
// changes must be ported by hand. This pin fails when footer.ts changes without a review.
const LAST_REVIEWED_UPSTREAM_SHA = "4954d7605";
const FOOTER_SHA256 = "44d0fdca06bad6b1c2743381671354e79507583f4662253bf6a59be007f18072";

describe("footer.ts upstream pin", () => {
	it("matches the last reviewed footer.ts", () => {
		const path = join(import.meta.dirname, "../src/modes/interactive/components/footer.ts");
		const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
		expect(
			actual,
			`upstream changed the shadowed footer.ts; review git log -p ${LAST_REVIEWED_UPSTREAM_SHA}..upstream/main -- packages/coding-agent/src/modes/interactive/components/footer.ts, port relevant changes into hummin-footer.ts, then update the pinned hash and the last-reviewed upstream sha in this test.`,
		).toBe(FOOTER_SHA256);
	});
});
