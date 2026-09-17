/**
 * Fork-identity guard.
 *
 * hummin is a rename-fork of pi (config dir, env names, binary name). During
 * the pi->hummin rename, tests that hardcoded the pre-rename identity strings
 * (".pi" agent dir, "PI_CODING_AGENT_DIR") silently broke and needed a full
 * sweep. This file makes that bug class impossible to reintroduce:
 *
 * 1. Snapshot the canonical identity constants, so any future rename surfaces
 *    here first and forces a conscious sweep.
 * 2. Ban hardcoded fork-identity literals in test files: tests must use the
 *    CONFIG_DIR_NAME / ENV_AGENT_DIR constants from src/config.ts instead.
 *    Upstream-compat literals (".pi", "PI_*") are deliberate and NOT banned;
 *    they reference the real upstream pi, not this fork's identity.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SELF = relative(REPO_ROOT, import.meta.filename).replace(/\\/g, "/");

/**
 * Test files that may hardcode fork-identity strings, with the reason. Files
 * mocking the constants themselves (vi.hoisted runs before imports) belong
 * here; anything else should use CONFIG_DIR_NAME / ENV_AGENT_DIR.
 */
const ALLOWED_TEST_FILES = new Set([
	// Mocks the config-dir constant itself; vi.hoisted cannot import it.
	"packages/coding-agent/test/suite/regressions/8261-subagent-project-trust.test.ts",
]);

const FORK_IDENTITY_PATTERNS: Array<[RegExp, string]> = [
	[/["'`]HUMMIN_CODING_AGENT_DIR["'`]/, "hardcoded agent-dir env name - use ENV_AGENT_DIR from ../src/config.ts"],
	[/["'`]\.hummin["'`]/, "hardcoded config-dir literal - use CONFIG_DIR_NAME from ../src/config.ts"],
];

function* walkTestFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walkTestFiles(full);
		} else if (full.endsWith(".test.ts")) {
			yield full;
		}
	}
}

describe("fork identity", () => {
	it("pins the canonical identity constants", () => {
		expect(APP_NAME).toBe("hummin");
		expect(CONFIG_DIR_NAME).toBe(".hummin");
		expect(ENV_AGENT_DIR).toBe("HUMMIN_CODING_AGENT_DIR");
	});

	it("test files never hardcode fork-identity literals (use CONFIG_DIR_NAME / ENV_AGENT_DIR)", () => {
		const violations: string[] = [];
		const testRoots = ["packages/coding-agent/test", "packages/tui/test", "packages/agent/test", "packages/ai/test"];
		for (const root of testRoots) {
			for (const file of walkTestFiles(join(REPO_ROOT, root))) {
				const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
				if (rel === SELF || ALLOWED_TEST_FILES.has(rel)) continue;
				const source = readFileSync(file, "utf8");
				for (const [pattern, reason] of FORK_IDENTITY_PATTERNS) {
					if (pattern.test(source)) {
						violations.push(`${rel}: ${reason}`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
