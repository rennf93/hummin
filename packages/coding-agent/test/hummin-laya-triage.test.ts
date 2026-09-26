import { expect, test, vi } from "vitest";
import {
	GATE_BLOCK_THRESHOLD,
	layaGateThreshold,
	layaSteerThreshold,
	looksLikeTestFailure,
	looksLikeTestRun,
	triageAdvisory,
	triageRateLimited,
} from "../extensions/hummin-laya.ts";

// Pure matchers and decisions for the test-failure triage read. The laya call
// itself is exercised only through the handler's fail-open path (live runs),
// so these tests cover the network-free surface.

// --- looksLikeTestRun ---------------------------------------------------------

test("looksLikeTestRun matches the supported test runners", () => {
	expect(looksLikeTestRun("npx vitest run test/foo.test.ts")).toBe(true);
	expect(
		looksLikeTestRun("node $(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js --run test/x.test.ts"),
	).toBe(true);
	expect(looksLikeTestRun("npm test")).toBe(true);
	expect(looksLikeTestRun("npm run test")).toBe(true);
	expect(looksLikeTestRun("python -m pytest tests/")).toBe(true);
	expect(looksLikeTestRun("cargo test --lib")).toBe(true);
	expect(looksLikeTestRun("go test ./...")).toBe(true);
	expect(looksLikeTestRun("node --test test/foo.test.ts")).toBe(true);
	expect(looksLikeTestRun("npx jest")).toBe(true);
	expect(looksLikeTestRun("./test.sh")).toBe(true);
	expect(looksLikeTestRun("npm test && npm run build")).toBe(true);
});

test("looksLikeTestRun rejects non-test commands", () => {
	expect(looksLikeTestRun("ls -la")).toBe(false);
	expect(looksLikeTestRun("git status")).toBe(false);
	expect(looksLikeTestRun("rm -rf build")).toBe(false);
	expect(looksLikeTestRun("echo hello world")).toBe(false);
	expect(looksLikeTestRun("")).toBe(false);
});

// --- looksLikeTestFailure -----------------------------------------------------

test("looksLikeTestFailure matches failing output from the common runners", () => {
	// vitest summary and FAIL line
	expect(looksLikeTestFailure("Tests  2 failed | 3 passed (5)")).toBe(true);
	expect(looksLikeTestFailure("\n FAIL  test/foo.test.ts > suite > case\n assertion error")).toBe(true);
	// jest summary
	expect(looksLikeTestFailure("Tests: 1 failed, 26 passed, 27 total")).toBe(true);
	// pytest
	expect(looksLikeTestFailure("=== FAILURES ===\nAssertionError: assert 1 == 2")).toBe(true);
	expect(looksLikeTestFailure("1 failed, 4 passed in 0.5s")).toBe(true);
	// go test
	expect(looksLikeTestFailure("--- FAIL: TestFoo (0.00s)")).toBe(true);
	// cargo test
	expect(looksLikeTestFailure("test result: FAILED. 0 passed; 1 failed")).toBe(true);
	expect(looksLikeTestFailure("error: test failed, to rerun pass `-p foo`")).toBe(true);
	// node:test tap
	expect(looksLikeTestFailure("not ok 1 - crashes on empty input")).toBe(true);
	// pipeline failure count
	expect(looksLikeTestFailure("3 failing")).toBe(true);
});

test("looksLikeTestFailure rejects passing output and counts of zero", () => {
	expect(looksLikeTestFailure("Tests  5 passed (5)")).toBe(false);
	expect(looksLikeTestFailure("ok 1 - handles empty input")).toBe(false);
	expect(looksLikeTestFailure("test result: ok. 5 passed; 0 failed")).toBe(false);
	expect(looksLikeTestFailure("=== 5 passed in 0.5s ===")).toBe(false);
	expect(looksLikeTestFailure("Tests: 26 passed, 26 total")).toBe(false);
	expect(looksLikeTestFailure("")).toBe(false);
});

// --- triageAdvisory and rate limit --------------------------------------------

test("triageAdvisory sends the hidden advisory only below the threshold", () => {
	const advisory = triageAdvisory(0.2);
	expect(advisory).toContain("P(caused_by_change)=0.20");
	expect(advisory).toContain("reproduces on HEAD");
	expect(triageAdvisory(0.45)).toBeUndefined();
	expect(triageAdvisory(0.9)).toBeUndefined();
});

test("triageRateLimited allows one read per 10 minutes", () => {
	const now = 1_000_000_000;
	expect(triageRateLimited(now, now - 9 * 60 * 1000)).toBe(true);
	expect(triageRateLimited(now, now - 11 * 60 * 1000)).toBe(false);
	// No previous read at all.
	expect(triageRateLimited(now, 0)).toBe(false);
});

// --- threshold resolution -----------------------------------------------------

test("gate and steer thresholds resolve from env, ignoring invalid values", () => {
	vi.stubEnv("HUMMIN_LAYA_GATE_THRESHOLD", "0.9");
	vi.stubEnv("HUMMIN_LAYA_STEER_THRESHOLD", "0.55");
	expect(layaGateThreshold()).toBe(0.9);
	expect(layaSteerThreshold()).toBe(0.55);
	// Unparseable and out-of-range env values are ignored, not trusted.
	vi.stubEnv("HUMMIN_LAYA_GATE_THRESHOLD", "abc");
	expect(layaGateThreshold()).toBe(0.75);
	vi.stubEnv("HUMMIN_LAYA_GATE_THRESHOLD", "1.5");
	expect(layaGateThreshold()).toBe(0.75);
	vi.stubEnv("HUMMIN_LAYA_GATE_THRESHOLD", "");
	expect(layaGateThreshold()).toBe(0.75);
	vi.unstubAllEnvs();
	// No env, no laya keys in the test project's settings: built-in defaults.
	expect(layaGateThreshold()).toBe(0.75);
	expect(layaSteerThreshold()).toBe(0.7);
});

test("the gate block fallback stays aligned with the settings-layer default", () => {
	// hummin-laya falls back to GATE_BLOCK_THRESHOLD when settings are
	// unreadable; settings-manager's getLayaGateThreshold() defaults to the
	// same 0.75, so blocking must not depend on settings readability.
	expect(GATE_BLOCK_THRESHOLD).toBe(0.75);
});
