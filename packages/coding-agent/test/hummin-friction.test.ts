import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminFriction, {
	FRICTION_REPORT_DAYS,
	renderFrictionReport,
	sessionSectionRows,
	sys1KindRows,
} from "../extensions/hummin-friction.ts";
import {
	appendFriction,
	boundDetail,
	FRICTION_LOG_MAX_BYTES,
	FRICTION_SESSION_STEER_AT,
	type FrictionEvent,
	parseFrictionLine,
	parseSys1GateEntry,
	readFrictionEvents,
	readSys1GateLines,
	resetSessionFrictionTally,
	SessionFrictionTally,
	sessionFrictionTally,
	summarizeFriction,
	summarizeSys1Calibration,
	summarizeSys1Gate,
	summarizeSys1Kinds,
} from "../extensions/lib/friction.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-friction-"));
	// The session tally lives on globalThis; keep tests isolated.
	resetSessionFrictionTally();
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const iso = (ms: number): string => new Date(ms).toISOString();
// Local-noon timestamps keep day bucketing deterministic in any timezone.
const localNoon = (year: number, month: number, day: number): number => new Date(year, month - 1, day, 12).getTime();
const NOW = localNoon(2026, 9, 24);

describe("parseFrictionLine", () => {
	it("parses a valid line; detail is optional", () => {
		expect(
			parseFrictionLine(
				'{"ts":"2026-09-24T10:00:00.000Z","kind":"tool_error","source":"guardrails","detail":"bash"}',
			),
		).toEqual({
			ts: "2026-09-24T10:00:00.000Z",
			kind: "tool_error",
			source: "guardrails",
			detail: "bash",
		});
		expect(parseFrictionLine('{"ts":"2026-09-24T10:00:00.000Z","kind":"advisory","source":"bashguard"}')).toEqual({
			ts: "2026-09-24T10:00:00.000Z",
			kind: "advisory",
			source: "bashguard",
		});
	});

	it("rejects corrupt and non-conforming lines", () => {
		expect(parseFrictionLine("not json")).toBeUndefined();
		expect(parseFrictionLine("[1,2]")).toBeUndefined();
		expect(parseFrictionLine('{"kind":"tool_error","source":"x"}')).toBeUndefined();
		expect(parseFrictionLine('{"ts":"2026-09-24T10:00:00.000Z","kind":"bogus","source":"x"}')).toBeUndefined();
		expect(parseFrictionLine('{"ts":"2026-09-24T10:00:00.000Z","kind":"tool_error"}')).toBeUndefined();
	});
});

describe("boundDetail", () => {
	it("clamps long details and keeps empty values undefined", () => {
		expect(boundDetail("x".repeat(500))).toHaveLength(200);
		expect(boundDetail("short")).toBe("short");
		expect(boundDetail(undefined)).toBeUndefined();
		expect(boundDetail("")).toBeUndefined();
	});
});

describe("appendFriction", () => {
	it("appends one parseable line, bounds the detail, and creates parent dirs", () => {
		const logPath = join(directory, "nested", "friction.log");
		appendFriction({ kind: "advisory", source: "bashguard", detail: "x".repeat(500) }, logPath);
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const event = parseFrictionLine(lines[0] ?? "");
		expect(event?.kind).toBe("advisory");
		expect(event?.source).toBe("bashguard");
		expect(event?.detail).toHaveLength(200);
	});

	it("drops the oldest half once the log exceeds the cap", () => {
		const logPath = join(directory, "friction.log");
		const lines: string[] = [];
		for (let i = 0; i < 14000; i++) {
			lines.push(`${JSON.stringify({ ts: iso(0), kind: "advisory", source: `old-${i}` })}\n`);
		}
		writeFileSync(logPath, lines.join(""));
		appendFriction({ kind: "tool_error", source: "guardrails", detail: "bash" }, logPath);
		const content = readFileSync(logPath, "utf8");
		expect(content).toContain('"source":"guardrails"');
		expect(content).not.toContain('"source":"old-0"');
		expect(statSync(logPath).size).toBeLessThanOrEqual(FRICTION_LOG_MAX_BYTES + 200);
	});

	it("never throws when the log path is unwritable", () => {
		expect(() => appendFriction({ kind: "advisory", source: "x" }, directory)).not.toThrow();
	});
});

describe("readFrictionEvents", () => {
	it("returns [] for a missing log", () => {
		expect(readFrictionEvents(7, join(directory, "missing.log"))).toEqual([]);
	});

	it("skips corrupt lines and applies the days window", () => {
		const logPath = join(directory, "friction.log");
		const recent = iso(Date.now() - 1 * 86_400_000);
		const old = iso(Date.now() - 30 * 86_400_000);
		writeFileSync(
			logPath,
			[
				"garbage",
				JSON.stringify({ ts: recent, kind: "tool_error", source: "guardrails", detail: "bash" }),
				JSON.stringify({ ts: old, kind: "advisory", source: "bashguard" }),
				"",
			].join("\n"),
		);
		const week = readFrictionEvents(7, logPath);
		expect(week).toHaveLength(1);
		expect(week[0]?.source).toBe("guardrails");
		expect(readFrictionEvents(0, logPath)).toHaveLength(2);
	});
});

describe("summarizeFriction", () => {
	it("counts kinds (zero-filled), sources, and per-day buckets oldest first", () => {
		const events: FrictionEvent[] = [
			{ ts: iso(localNoon(2026, 9, 22)), kind: "tool_error", source: "guardrails" },
			{ ts: iso(localNoon(2026, 9, 23)), kind: "tool_error", source: "guardrails" },
			{ ts: iso(localNoon(2026, 9, 23)), kind: "advisory", source: "bashguard" },
			{ ts: iso(localNoon(2026, 9, 24)), kind: "lsp_stub", source: "lsp" },
		];
		const summary = summarizeFriction(events, { nowMs: NOW, days: 3 });
		expect(summary.total).toBe(4);
		expect(summary.byKind).toEqual({
			tool_error: 2,
			tool_rejected: 0,
			circuit_breaker: 0,
			loop_detected: 0,
			advisory: 1,
			lsp_stub: 1,
		});
		expect(summary.bySource).toEqual({ guardrails: 2, bashguard: 1, lsp: 1 });
		expect(summary.perDay).toEqual([
			{ day: "2026-09-22", count: 1 },
			{ day: "2026-09-23", count: 2 },
			{ day: "2026-09-24", count: 1 },
		]);
	});

	it("counts out-of-window and unparseable-ts events in totals but not per-day", () => {
		const events: FrictionEvent[] = [
			{ ts: iso(localNoon(2026, 9, 1)), kind: "advisory", source: "bashguard" },
			{ ts: "not-a-date", kind: "advisory", source: "bashguard" },
			{ ts: iso(NOW), kind: "tool_error", source: "guardrails" },
		];
		const summary = summarizeFriction(events, { nowMs: NOW, days: 7 });
		expect(summary.total).toBe(3);
		expect(summary.bySource).toEqual({ bashguard: 2, guardrails: 1 });
		expect(summary.perDay.reduce((sum, entry) => sum + entry.count, 0)).toBe(1);
		expect(summary.perDay.find((entry) => entry.day === "2026-09-24")?.count).toBe(1);
	});

	it("handles empty input with zero-filled day buckets", () => {
		const summary = summarizeFriction([], { nowMs: NOW, days: 7 });
		expect(summary.total).toBe(0);
		expect(summary.perDay).toHaveLength(7);
		expect(summary.perDay.every((entry) => entry.count === 0)).toBe(true);
	});
});

describe("sys1 gate summary", () => {
	it("counts block/confirmed/read and ignores unknown or corrupt lines", () => {
		const summary = summarizeSys1Gate([
			'{"ts":"2026-09-24T10:00:00.000Z","type":"block","command":"rm -rf /","p":0.9}',
			'{"ts":"2026-09-24T11:00:00.000Z","type":"confirmed","command":"rm -rf /"}',
			'{"ts":"2026-09-24T12:00:00.000Z","type":"confirmed","command":"x"}',
			'{"ts":"2026-09-24T13:00:00.000Z","type":"read"}',
			'{"ts":"2026-09-24T14:00:00.000Z","type":"mystery"}',
			"garbage",
			"",
		]);
		expect(summary).toEqual({ block: 1, confirmed: 2, read: 1 });
	});

	it("reads a log tolerantly; missing file yields []", () => {
		expect(readSys1GateLines(join(directory, "missing.log"))).toEqual([]);
		const logPath = join(directory, "sys1-gate.log");
		writeFileSync(
			logPath,
			'{"ts":"2026-09-24T10:00:00.000Z","type":"block","command":"x"}\nnot json\n{"ts":"2026-09-24T11:00:00.000Z","type":"read"}\n',
		);
		expect(summarizeSys1Gate(readSys1GateLines(logPath))).toEqual({ block: 1, confirmed: 0, read: 1 });
	});
});

describe("renderFrictionReport", () => {
	const zeroSummary = () => summarizeFriction([], { nowMs: NOW, days: FRICTION_REPORT_DAYS });
	const block = (p: number) => ({ type: "block" as const, p });
	const confirmed = (p?: number) =>
		p === undefined ? { type: "confirmed" as const } : { type: "confirmed" as const, p };
	const read = (kind: string, p: number) => ({ type: "read" as const, kind, p });

	it("renders a single-line empty state when there is nothing at all", () => {
		expect(renderFrictionReport(zeroSummary(), { block: 0, confirmed: 0, read: 0 })).toBe(
			`No friction recorded in the last ${FRICTION_REPORT_DAYS} days.`,
		);
	});

	it("renders kind totals, per-day counts, and the sys1 gate section", () => {
		const friction = summarizeFriction(
			[
				{ ts: iso(NOW), kind: "tool_error", source: "guardrails" },
				{ ts: iso(NOW), kind: "advisory", source: "bashguard" },
			],
			{ nowMs: NOW, days: FRICTION_REPORT_DAYS },
		);
		const text = renderFrictionReport(friction, { block: 2, confirmed: 1, read: 0 });
		expect(text).toContain("Friction, last 7 days (total 2)");
		expect(text).toContain("tool_error");
		expect(text).toContain("per day");
		expect(text).toContain("2026-09-24");
		expect(text).toContain("sys1 gate");
		expect(text).toContain("confirmed");
	});

	it("still shows the sys1 gate section when friction is empty", () => {
		const text = renderFrictionReport(zeroSummary(), { block: 1, confirmed: 0, read: 0 });
		expect(text).toContain("total 0");
		expect(text).toContain("sys1 gate");
	});

	it("appends the calibration section with a suggestion when the bands separate", () => {
		const calibration = summarizeSys1Calibration([block(0.8), confirmed(0.76), read("gate", 0.71)], {
			threshold: 0.75,
		});
		const text = renderFrictionReport(zeroSummary(), { block: 1, confirmed: 1, read: 1 }, calibration);
		expect(text).toContain("sys1 calibration (threshold 0.75)");
		expect(text).toContain("near-miss reads");
		expect(text).toContain("consider settings decision.gateThreshold 0.78");
	});

	it("renders the bimodality note instead of a suggestion when the bands overlap", () => {
		const calibration = summarizeSys1Calibration([block(0.76), confirmed(0.76), read("gate", 0.71)], {
			threshold: 0.75,
		});
		const text = renderFrictionReport(zeroSummary(), { block: 1, confirmed: 1, read: 1 }, calibration);
		expect(text).toContain("sys1 calibration (threshold 0.75)");
		expect(text).toContain("not enough separation to suggest");
		expect(text).not.toContain("consider settings");
	});

	it("omits the calibration section when there is nothing to calibrate", () => {
		const calibration = summarizeSys1Calibration([read("gate", 0.2)], { threshold: 0.75 });
		const text = renderFrictionReport(zeroSummary(), { block: 1, confirmed: 0, read: 1 }, calibration);
		expect(text).not.toContain("sys1 calibration");
	});
});

describe("sys1 kind sections", () => {
	const read = (kind: string, p: number) => ({ type: "read" as const, kind, p });
	const zeroSummary = () => summarizeFriction([], { nowMs: NOW, days: FRICTION_REPORT_DAYS });

	it("renders one section per non-gate kind with data and skips gate", () => {
		const kinds = summarizeSys1Kinds([read("gate", 0.62), read("steer", 0.85), read("decide", 0.2)], {
			thresholds: { steer: 0.8 },
		});
		const text = renderFrictionReport(zeroSummary(), { block: 0, confirmed: 0, read: 3 }, undefined, [], kinds);
		expect(text).toContain("sys1 steer (threshold 0.80)");
		expect(text).toContain("sys1 decide");
		expect(text).not.toContain("sys1 gate (threshold");
		// the gate kind's reads still appear in the all-time gate section
		expect(text).toContain("sys1 gate (all time)");
		expect(text).toMatch(/read\s+3/);
	});

	it("renders the near-miss row for a thresholded kind", () => {
		const kinds = summarizeSys1Kinds([read("steer", 0.55), read("steer", 0.79), read("steer", 0.85)], {
			thresholds: { steer: 0.8 },
		});
		expect(sys1KindRows(kinds[0])).toContainEqual(["near-miss reads", "2 passed at 0.50-0.80 (max 0.79)"]);
		const text = renderFrictionReport(zeroSummary(), { block: 0, confirmed: 0, read: 3 }, undefined, [], kinds);
		expect(text).toContain("near-miss reads");
	});
});

describe("parseSys1GateEntry", () => {
	it("extracts type, kind, p, and command; corrupt lines yield undefined", () => {
		expect(parseSys1GateEntry('{"ts":"t","type":"block","command":"rm -rf x","p":0.91}')).toEqual({
			ts: "t",
			type: "block",
			command: "rm -rf x",
			p: 0.91,
		});
		expect(parseSys1GateEntry('{"type":"read","kind":"gate","p":0.62}')).toEqual({
			type: "read",
			kind: "gate",
			p: 0.62,
		});
		expect(parseSys1GateEntry('{"type":"confirmed","command":"x"}')).toEqual({ type: "confirmed", command: "x" });
		// a non-numeric p is dropped rather than trusted
		expect(parseSys1GateEntry('{"type":"read","kind":"gate","p":"high"}')).toEqual({ type: "read", kind: "gate" });
		expect(parseSys1GateEntry("garbage")).toBeUndefined();
		expect(parseSys1GateEntry('{"type":"nope"}')).toBeUndefined();
	});
});

describe("summarizeSys1Calibration", () => {
	const block = (p: number) => ({ type: "block" as const, p });
	const confirmed = (p?: number) =>
		p === undefined ? { type: "confirmed" as const } : { type: "confirmed" as const, p };
	const read = (kind: string, p: number) => ({ type: "read" as const, kind, p });

	it("summarizes the block score distribution and near-miss gate reads", () => {
		const calibration = summarizeSys1Calibration(
			[
				block(0.9),
				block(0.76),
				block(0.83),
				read("gate", 0.72),
				read("gate", 0.4),
				read("gate", 0.75),
				read("steer", 0.7),
				confirmed(),
			],
			{ threshold: 0.75 },
		);
		expect(calibration.blocks).toBe(3);
		expect(calibration.blockP).toEqual({ min: 0.76, median: 0.83, max: 0.9 });
		// 0.72 counts as a near miss; 0.4 is below the floor, 0.75 is not below
		// the threshold, steer reads never count, unjoined confirms are counted
		// but carry no score.
		expect(calibration.nearMisses).toBe(1);
		expect(calibration.nearMissMax).toBe(0.72);
		expect(calibration.confirmed).toBe(0);
		expect(calibration.suggestedThreshold).toBeUndefined();
		// no scored confirmations: no separation to evaluate
		expect(calibration.separation).toBe("unknown");
	});

	it("suppresses the suggestion when confirmed scores sit inside the blocked band", () => {
		// The 2026-09 shape: a confirmed false positive inside the blocked
		// band, so raising the threshold would also clear true positives.
		const calibration = summarizeSys1Calibration(
			[block(0.94), block(0.76), confirmed(0.76), confirmed(0.55), confirmed()],
			{ threshold: 0.75 },
		);
		expect(calibration.blocks).toBe(2);
		expect(calibration.confirmed).toBe(2);
		expect(calibration.confirmedScores).toEqual([0.76, 0.55]);
		expect(calibration.confirmedMax).toBe(0.76);
		expect(calibration.blockMin).toBe(0.76);
		expect(calibration.suggestedThreshold).toBeUndefined();
		expect(calibration.separation).toBe("overlap");
	});

	it("suggests just above the lowest confirmed score when the bands separate", () => {
		const calibration = summarizeSys1Calibration([block(0.94), block(0.8), confirmed(0.76), confirmed(0.55)], {
			threshold: 0.75,
		});
		// 0.55 already passes at 0.75, so 0.76 is the binding constraint; 0.78
		// clears every confirmed score and still blocks everything logged.
		expect(calibration.suggestedThreshold).toBe(0.78);
		expect(calibration.separation).toBe("separated");
		expect(calibration.confirmedMax).toBe(0.76);
		expect(calibration.blockMin).toBe(0.8);
	});

	it("suggests safely when a binding confirmed score exists but no block carries a score", () => {
		// Rule blocks log without p: raising the score threshold cannot
		// unblock them, so the suggestion is provably safe.
		const calibration = summarizeSys1Calibration([confirmed(0.8), read("gate", 0.4)], { threshold: 0.75 });
		expect(calibration.suggestedThreshold).toBe(0.82);
		expect(calibration.separation).toBe("separated");
		expect(calibration.blockMin).toBeUndefined();
	});

	it("suppresses the suggestion when the candidate equals the highest confirmed score", () => {
		// Guards the strict `candidate > confirmedMax` comparison: at 0.78 the
		// confirmed false positive at 0.78 would keep blocking, so 0.78 is not
		// a safe suggestion.
		const calibration = summarizeSys1Calibration([block(0.9), confirmed(0.76), confirmed(0.78), confirmed(0.55)], {
			threshold: 0.75,
		});
		expect(calibration.confirmedMax).toBe(0.78);
		expect(calibration.suggestedThreshold).toBeUndefined();
		expect(calibration.separation).toBe("overlap");
	});

	it("suggests when the candidate equals the lowest scored block score", () => {
		// The gate blocks at p >= threshold, so a candidate exactly equal to a
		// block score still blocks that command.
		const calibration = summarizeSys1Calibration([block(0.78), confirmed(0.76)], { threshold: 0.75 });
		expect(calibration.suggestedThreshold).toBe(0.78);
		expect(calibration.separation).toBe("separated");
	});

	it("clamps the suggestion at 0.99 and yields nothing without data", () => {
		const clamped = summarizeSys1Calibration([block(0.995), confirmed(0.985)], { threshold: 0.75 });
		expect(clamped.suggestedThreshold).toBe(0.99);
		expect(clamped.separation).toBe("separated");
		const empty = summarizeSys1Calibration([], { threshold: 0.75 });
		expect(empty.blocks).toBe(0);
		expect(empty.blockP).toBeUndefined();
		expect(empty.confirmed).toBe(0);
		expect(empty.nearMisses).toBe(0);
		expect(empty.suggestedThreshold).toBeUndefined();
		expect(empty.separation).toBe("unknown");
	});
});

describe("summarizeSys1Kinds", () => {
	const read = (kind: string, p?: number) =>
		p === undefined ? { type: "read" as const, kind } : { type: "read" as const, kind, p };
	const thresholds = { steer: 0.8, triage: 0.45, intake: 0.5, ask: 0.7 };

	it("summarizes per-kind reads with score stats and near-miss bands", () => {
		const summaries = summarizeSys1Kinds(
			[
				read("gate", 0.62),
				read("steer", 0.1),
				read("steer", 0.83),
				read("steer", 0.85),
				read("triage", 0.3),
				read("decide", 0.2),
			],
			{ thresholds },
		);
		expect(summaries.map((summary) => summary.kind)).toEqual(["steer", "gate", "decide", "triage"]);
		const steer = summaries[0];
		expect(steer.reads).toBe(3);
		expect(steer.readP).toEqual({ min: 0.1, median: 0.83, max: 0.85 });
		expect(steer.threshold).toBe(0.8);
		// 0.83 and 0.85 are above the threshold; only 0.1 is below the floor
		expect(steer.nearMisses).toBe(0);
		expect(summaries[1]?.readP).toEqual({ min: 0.62, median: 0.62, max: 0.62 });
		expect(summaries[1]?.threshold).toBeUndefined();
		// decide has no threshold: reads and stats only, no near-miss
		expect(summaries[2]?.threshold).toBeUndefined();
		expect(summaries[2]?.nearMisses).toBe(0);
		expect(summaries[3]?.nearMisses).toBe(0);
	});

	it("counts near-miss reads inside [floor, threshold) for thresholded kinds", () => {
		const summaries = summarizeSys1Kinds([read("steer", 0.55), read("steer", 0.79), read("steer", 0.8)], {
			thresholds,
		});
		const steer = summaries[0];
		expect(steer.nearMisses).toBe(2);
		expect(steer.nearMissMax).toBe(0.79);
	});

	it("returns only kinds with reads, canonical order first, unknown kinds after", () => {
		const summaries = summarizeSys1Kinds([read("custom", 0.4), read("ask", 0.2)], { thresholds });
		expect(summaries.map((summary) => summary.kind)).toEqual(["ask", "custom"]);
		expect(summarizeSys1Kinds([], { thresholds })).toEqual([]);
	});
});

describe("SessionFrictionTally", () => {
	it("counts tool_error and tool_rejected per source and keeps insertion order", () => {
		const tally = new SessionFrictionTally();
		tally.record("tool_error", "guardrails", "bash");
		tally.record("tool_error", "guardrails", "edit");
		tally.record("tool_rejected", "guardrails");
		tally.record("tool_error", "other");
		tally.record("advisory", "bashguard");
		expect(tally.snapshot()).toEqual([
			{ source: "guardrails", toolErrors: 2, toolRejections: 1 },
			{ source: "other", toolErrors: 1, toolRejections: 0 },
		]);
	});

	it("ignores uncounted kinds entirely: no entry, no totals, no crossing", () => {
		const tally = new SessionFrictionTally();
		tally.record("tool_error", "guardrails", "bash");
		const ignored = tally.record("advisory", "bashguard", "notice");
		expect(ignored.crossed).toBe(false);
		expect(tally.snapshot()).toEqual([{ source: "guardrails", toolErrors: 1, toolRejections: 0 }]);
		// a counted record without detail keeps the source's last detail
		expect(tally.record("tool_error", "guardrails").lastDetail).toBe("bash");
	});

	it("crosses exactly at the steer threshold, once per source, latched", () => {
		const tally = new SessionFrictionTally();
		const records = [
			tally.record("tool_error", "guardrails"),
			tally.record("tool_error", "guardrails"),
			tally.record("tool_error", "guardrails"),
		];
		expect(records.map((record) => record.crossed)).toEqual([false, false, true]);
		expect(records[2]?.total).toBe(FRICTION_SESSION_STEER_AT);
		tally.markSteered("guardrails");
		const after = tally.record("tool_error", "guardrails");
		expect(after.crossed).toBe(false);
		expect(after.steered).toBe(true);
		expect(after.total).toBe(FRICTION_SESSION_STEER_AT + 1);
	});

	it("counts both kinds towards the threshold and steers per source", () => {
		const tally = new SessionFrictionTally();
		tally.record("tool_rejected", "guardrails");
		tally.record("tool_rejected", "guardrails");
		const third = tally.record("tool_error", "guardrails");
		expect(third.crossed).toBe(true);
		// a different source starts from zero
		expect(tally.record("tool_error", "lsp").crossed).toBe(false);
	});

	it("isEmpty mirrors the snapshot", () => {
		const tally = new SessionFrictionTally();
		expect(tally.isEmpty()).toBe(true);
		tally.record("tool_error", "guardrails");
		expect(tally.isEmpty()).toBe(false);
	});
});

describe("sessionFrictionTally", () => {
	it("returns the same shared instance until reset", () => {
		const first = sessionFrictionTally();
		expect(sessionFrictionTally()).toBe(first);
		first.record("tool_error", "guardrails");
		const fresh = resetSessionFrictionTally();
		expect(sessionFrictionTally()).toBe(fresh);
		expect(fresh.isEmpty()).toBe(true);
		expect(sessionFrictionTally()).not.toBe(first);
	});
});

describe("session section rendering", () => {
	it("renders one row per source with only the nonzero kinds", () => {
		expect(
			sessionSectionRows([
				{ source: "guardrails", toolErrors: 2, toolRejections: 1 },
				{ source: "lsp", toolErrors: 0, toolRejections: 1 },
			]),
		).toEqual([
			["guardrails", "tool_error 2, tool_rejected 1"],
			["lsp", "tool_rejected 1"],
		]);
	});

	it("lists the session counts above the historical digest", () => {
		const friction = summarizeFriction([{ ts: iso(NOW), kind: "tool_error", source: "guardrails" }], {
			nowMs: NOW,
			days: FRICTION_REPORT_DAYS,
		});
		const text = renderFrictionReport(friction, { block: 0, confirmed: 0, read: 0 }, undefined, [
			{ source: "guardrails", toolErrors: 3, toolRejections: 0 },
		]);
		const sessionAt = text.indexOf("this session");
		const digestAt = text.indexOf(`Friction, last ${FRICTION_REPORT_DAYS} days`);
		expect(sessionAt).toBeGreaterThanOrEqual(0);
		expect(sessionAt).toBeLessThan(digestAt);
		expect(text).toContain("tool_error 3");
	});

	it("omits the section when the session has no counts and keeps the empty state", () => {
		const text = renderFrictionReport(summarizeFriction([], { nowMs: NOW, days: FRICTION_REPORT_DAYS }), {
			block: 0,
			confirmed: 0,
			read: 0,
		});
		expect(text).not.toContain("this session");
		expect(
			renderFrictionReport(summarizeFriction([], { nowMs: NOW, days: FRICTION_REPORT_DAYS }), {
				block: 0,
				confirmed: 0,
				read: 0,
			}),
		).toBe(`No friction recorded in the last ${FRICTION_REPORT_DAYS} days.`);
	});

	it("renders the session section alone when there is no history at all", () => {
		const text = renderFrictionReport(
			summarizeFriction([], { nowMs: NOW, days: FRICTION_REPORT_DAYS }),
			{
				block: 0,
				confirmed: 0,
				read: 0,
			},
			undefined,
			[{ source: "guardrails", toolErrors: 1, toolRejections: 0 }],
		);
		expect(text).toContain("this session");
		expect(text).toContain("total 0");
	});
});

describe("/friction command", () => {
	function fakePi(): {
		api: ExtensionAPI;
		commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	} {
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const api = {
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
			) => {
				commands.set(name, command);
			},
		} as unknown as ExtensionAPI;
		return { api, commands };
	}

	function fakeCtx(notified: string[]): ExtensionContext {
		return {
			ui: {
				notify: (text: string) => {
					notified.push(text);
				},
			},
		} as unknown as ExtensionContext;
	}

	it("registers, reads the redirected agent paths, and notifies a summary", async () => {
		vi.stubEnv(ENV_AGENT_DIR, directory);
		const { api, commands } = fakePi();
		humminFriction(api);
		const command = commands.get("friction");
		expect(command).toBeDefined();
		if (!command) return;
		appendFriction({ kind: "tool_error", source: "guardrails", detail: "bash" });
		writeFileSync(
			join(directory, "sys1-gate.log"),
			'{"ts":"2026-09-24T10:00:00.000Z","type":"block","command":"x"}\n',
		);
		const notified: string[] = [];
		await command.handler("", fakeCtx(notified));
		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain("tool_error");
		expect(notified[0]).toContain("sys1 gate");
	});

	it("degrades gracefully on a nonexistent agent dir", async () => {
		vi.stubEnv(ENV_AGENT_DIR, join(directory, "absent"));
		const { api, commands } = fakePi();
		humminFriction(api);
		const command = commands.get("friction");
		if (!command) throw new Error("friction command not registered");
		const notified: string[] = [];
		await command.handler("", fakeCtx(notified));
		expect(notified).toEqual([`No friction recorded in the last ${FRICTION_REPORT_DAYS} days.`]);
	});

	it("includes the live session counts above the historical digest", async () => {
		vi.stubEnv(ENV_AGENT_DIR, join(directory, "absent"));
		const { api, commands } = fakePi();
		humminFriction(api);
		const command = commands.get("friction");
		if (!command) throw new Error("friction command not registered");
		sessionFrictionTally().record("tool_error", "guardrails", "bash");
		const notified: string[] = [];
		await command.handler("", fakeCtx(notified));
		expect(notified).toHaveLength(1);
		const text = notified[0] ?? "";
		expect(text).toContain("this session");
		expect(text).toContain("tool_error 1");
		expect(text.indexOf("this session")).toBeLessThan(text.indexOf(`Friction, last ${FRICTION_REPORT_DAYS} days`));
	});
});
