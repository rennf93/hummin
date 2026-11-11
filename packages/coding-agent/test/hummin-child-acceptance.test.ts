import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACCEPT_INSPECT_BELOW,
	ACCEPT_REPORT_MAX_CHARS,
	acceptanceNote,
	acceptanceState,
	childAcceptanceCheck,
	resetAcceptanceFailureMemo,
} from "../extensions/lib/child-acceptance.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-child-acceptance-"));
	vi.stubEnv(ENV_AGENT_DIR, directory);
	resetAcceptanceFailureMemo();
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("acceptanceState", () => {
	it("composes the brief and the report, keeping the report tail when oversized", () => {
		const state = acceptanceState("fix the flaky test", "step 1\nstep 2\nfinal: done, all green");
		expect(state).toContain("fix the flaky test");
		expect(state).toContain("final: done, all green");
		const bigReport = Array.from({ length: ACCEPT_REPORT_MAX_CHARS * 2 }, () => "a").join("");
		const bounded = acceptanceState("brief", bigReport);
		expect(bounded).toContain(
			`[report truncated to the last ${ACCEPT_REPORT_MAX_CHARS} of ${bigReport.length} chars]`,
		);
		expect(bounded.endsWith("a".repeat(ACCEPT_REPORT_MAX_CHARS))).toBe(true);
	});

	it("marks a missing report instead of composing an empty one", () => {
		expect(acceptanceState("brief", "")).toContain("(no report captured)");
		expect(acceptanceState("brief", "   \n")).toContain("(no report captured)");
	});
});

describe("acceptanceNote", () => {
	it("asks for inspection below the inspect line and stays plain at or above it", () => {
		const low = acceptanceNote(ACCEPT_INSPECT_BELOW - 0.01);
		expect(low).toContain("[sys1 acceptance]");
		expect(low).toContain("inspect before relying on it");
		const high = acceptanceNote(ACCEPT_INSPECT_BELOW);
		expect(high).toContain("[sys1 acceptance]");
		expect(high).not.toContain("inspect");
	});
});

describe("childAcceptanceCheck", () => {
	const readOk = async () => ({ noul: 0.7 });

	it("returns the score and appends one accept audit line", async () => {
		const p = await childAcceptanceCheck({ what: "brief", report: "report", cwd: directory, read: readOk });
		expect(p).toBe(0.7);
		const lines = readFileSync(join(directory, "sys1-gate.log"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({ type: "read", kind: "accept", p: 0.7 });
	});

	it("is a no-op with the kill switch set, and never calls the engine", async () => {
		vi.stubEnv("HUMMIN_SYS1_ACCEPT", "off");
		let called = 0;
		const p = await childAcceptanceCheck({
			what: "brief",
			report: "report",
			cwd: directory,
			read: async () => {
				called += 1;
				return { noul: 0.9 };
			},
		});
		expect(p).toBeUndefined();
		expect(called).toBe(0);
	});

	it("fails open on a null, NaN, out-of-range, or throwing read", async () => {
		expect(
			await childAcceptanceCheck({ what: "b", report: "r", cwd: directory, read: async () => null }),
		).toBeUndefined();
		resetAcceptanceFailureMemo();
		expect(
			await childAcceptanceCheck({
				what: "b",
				report: "r",
				cwd: directory,
				read: async () => ({ noul: Number.NaN }),
			}),
		).toBeUndefined();
		resetAcceptanceFailureMemo();
		expect(
			await childAcceptanceCheck({ what: "b", report: "r", cwd: directory, read: async () => ({ noul: 1.5 }) }),
		).toBeUndefined();
		resetAcceptanceFailureMemo();
		expect(
			await childAcceptanceCheck({
				what: "b",
				report: "r",
				cwd: directory,
				read: async () => {
					throw new Error("boom");
				},
			}),
		).toBeUndefined();
		expect(() => readFileSync(join(directory, "sys1-gate.log"))).toThrow();
	});

	it("skips reads for a while after a failure instead of taxing every result", async () => {
		expect(
			await childAcceptanceCheck({ what: "b", report: "r", cwd: directory, read: async () => ({ noul: 1.5 }) }),
		).toBeUndefined();
		let called = 0;
		const p = await childAcceptanceCheck({
			what: "b",
			report: "r",
			cwd: directory,
			read: async () => {
				called += 1;
				return { noul: 0.9 };
			},
		});
		expect(p).toBeUndefined();
		expect(called).toBe(0);
		resetAcceptanceFailureMemo();
		expect(
			await childAcceptanceCheck({
				what: "b",
				report: "r",
				cwd: directory,
				read: async () => {
					called += 1;
					return { noul: 0.9 };
				},
			}),
		).toBe(0.9);
		expect(called).toBe(1);
	});
});
