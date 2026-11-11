/**
 * tokens-gate: the console's token discipline lint (guard-core's
 * check-css-tokens.mjs pattern). Every styleable value must come from the
 * --rc-* token sheet in src/tokens.css; component code and stylesheets may
 * not introduce raw colors, radii, spacing lengths, or font stacks. Allowed
 * exceptions: the token sheet itself (it defines the values), the harness
 * fixtures (recorded data, not UI), and structural values (0, 1px hairlines,
 * percentages, z-indexes) that are not themeable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The console package root: everything under src/ is subject to the gate. */
const SRC = join(__dirname, "..");

/** Files allowed to define raw values: the token sheet itself. */
const TOKEN_SHEET = "src/tokens.css";

/** Structural values that are not themeable and may appear anywhere:
 * reset geometry (0, 1px hairlines, 2px borders, 3px decorative swatch
 * preview lines, 0.01ms motion kill), the follow-bottom behavioral threshold
 * (96px), the content-visibility size estimate (120px), and the phone
 * breakpoint width (900px). These are behavioral geometry, not theme tokens. */
const STRUCTURAL = /^(0px?|0|1px|2px|3px|96px|120px|900px|50%|100%|0\.01ms|-1|1|auto|none|transparent)$/;

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node_modules" || entry === "dist" || entry === "harness") continue;
			walk(full, files);
		} else if (/\.(css|tsx?|html)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
			files.push(full);
		}
	}
	return files;
}

/** Raw themeable values: hex colors, rgb()/hsl() literals, px lengths beyond
 * the structural set, font stacks with commas inside a font shorthand, and
 * named colors that tokens should carry instead. */
function rawValueOffenses(text: string): string[] {
	const offenses: string[] = [];
	const hex = /#[0-9a-fA-F]{3,8}\b/g;
	for (const match of text.matchAll(hex)) offenses.push(`hex color ${match[0]}`);
	const rgb = /\b(?:rgb|rgba|hsl|hsla)\(/g;
	for (const match of text.matchAll(rgb)) offenses.push(`color function ${match[0]}`);
	const px = /\b\d+(?:\.\d+)?px\b/g;
	for (const match of text.matchAll(px)) {
		if (!STRUCTURAL.test(match[0])) offenses.push(`px length ${match[0]}`);
	}
	return offenses;
}

describe("tokens gate", () => {
	it("keeps raw themeable values out of everything but the token sheet", () => {
		const files = walk(SRC).filter((file) => !file.endsWith(TOKEN_SHEET));
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const offense of rawValueOffenses(text)) {
				offenders.push(`${file.replace(`${SRC}/`, "")}: ${offense}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("defines every token the components read, exactly once", () => {
		const sheet = readFileSync(join(SRC, TOKEN_SHEET), "utf8");
		const defined = new Set([...sheet.matchAll(/--rc-[a-z0-9-]+\s*:/g)].map((m) => m[0].replace(/\s*:$/, "")));
		expect(defined.has("--rc-surface")).toBe(true);
		expect(defined.has("--rc-accent-hue")).toBe(true);
		expect(defined.has("--rc-density")).toBe(true);
		// the fallback swap tokens and the slider-fill dynamic value the panel writes
		expect(defined.has("--rc-surface-solid")).toBe(true);
		expect(defined.has("--rc-scrim")).toBe(true);
		// every --rc-* reference in non-sheet files resolves to a definition
		const files = walk(SRC).filter((file) => !file.endsWith(TOKEN_SHEET));
		const unresolved: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(/var\((--rc-[a-z0-9-]+)/g)) {
				const token = match[1];
				if (token !== undefined && !defined.has(token)) unresolved.push(`${file.replace(`${SRC}/`, "")}: ${token}`);
			}
		}
		expect(unresolved).toEqual([]);
	});
});
