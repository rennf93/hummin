import { describe, expect, it } from "vitest";
import type { BackgroundJobRow, ProcessJob } from "../extensions/lib/processes.ts";
import {
	formatBackgroundStatus,
	jobRows,
	outputTail,
	runningCountByKind,
	stateGlyph,
} from "../extensions/lib/processes.ts";

const NOW = 1_000_000;

function job(
	overrides: Partial<{ kind: string; state: string; label: string; startedAt: number; logFile: string; id: string }>,
): ProcessJob {
	return {
		id: overrides.id ?? "id",
		kind: overrides.kind ?? "task",
		label: overrides.label ?? "label",
		logFile: overrides.logFile ?? "/tmp/log",
		startedAt: overrides.startedAt ?? NOW - 30_000,
		state: (overrides.state ?? "running") as BackgroundJobRow["state"],
	} as unknown as ProcessJob;
}

describe("runningCountByKind", () => {
	it("counts running jobs per kind and omits zero kinds", () => {
		const jobs = [
			job({ kind: "task" }),
			job({ kind: "task" }),
			job({ kind: "monitor" }),
			job({ kind: "task", state: "completed" }),
		];
		expect(runningCountByKind(jobs)).toEqual([
			{ kind: "monitor", count: 1 },
			{ kind: "task", count: 2 },
		]);
	});

	it("returns empty for all-idle jobs", () => {
		expect(runningCountByKind([job({ state: "failed" })])).toEqual([]);
	});
});

describe("formatBackgroundStatus", () => {
	it("formats by kind with pluralization", () => {
		expect(
			formatBackgroundStatus([
				{ kind: "task", count: 2 },
				{ kind: "monitor", count: 1 },
			]),
		).toBe("2 tasks, 1 monitor");
	});

	it("is undefined when idle", () => {
		expect(formatBackgroundStatus([])).toBeUndefined();
	});
});

describe("stateGlyph", () => {
	it("maps each state to a distinct glyph", () => {
		expect(stateGlyph("running")).toBe("●");
		expect(stateGlyph("completed")).toBe("✓");
		expect(stateGlyph("failed")).toBe("✗");
		expect(stateGlyph("timed_out")).toBe("✗");
		expect(stateGlyph("cancelled")).toBe("○");
	});
});

describe("jobRows", () => {
	it("shapes rows with glyph, duration, and log path", () => {
		const rows = jobRows([job({ label: "alpha" })], NOW);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "task",
			state: "running",
			glyph: "●",
			label: "alpha",
			duration: "30s",
			logFile: "/tmp/log",
		});
	});

	it("lists running jobs before finished ones", () => {
		const rows = jobRows([job({ label: "done", state: "completed" }), job({ label: "live" })], NOW);
		expect(rows.map((row) => row.label)).toEqual(["live", "done"]);
	});

	it("includes error only when present", () => {
		const withError = { ...job({}), error: "boom" };
		expect(jobRows([withError], NOW)[0].error).toBe("boom");
		expect(jobRows([job({})], NOW)[0].error).toBeUndefined();
	});
});

describe("outputTail", () => {
	it("returns last 30 lines", () => {
		const text = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
		const tail = outputTail(text);
		expect(tail.split("\n")).toHaveLength(30);
		expect(tail.split("\n")[0]).toBe("line-11");
		expect(tail.split("\n").at(-1)).toBe("line-40");
	});

	it("returns everything when shorter than the cap", () => {
		expect(outputTail("a\nb")).toBe("a\nb");
	});
});
