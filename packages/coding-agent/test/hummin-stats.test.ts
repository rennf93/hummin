import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminStats, {
	EMPTY_STATS_MESSAGE,
	nearestRankPercentile,
	type ParsedTelemetryRecord,
	parseTelemetryLine,
	readTelemetryRecords,
	renderStatsReport,
	STATS_MAX_FILE_BYTES,
	STATS_MAX_FILES,
	summarizeTelemetryStats,
} from "../extensions/hummin-stats.ts";

/** ISO timestamp for a local wall-clock time, so bucketing asserts hold in any TZ. */
function localTs(year: number, month: number, day: number, hour: number, minute = 0, second = 0, ms = 0): string {
	return new Date(year, month - 1, day, hour, minute, second, ms).toISOString();
}

function eventLine(ts: string, name: string, attributes: Record<string, unknown>): string {
	return `${JSON.stringify({ ts, kind: "event", name, attributes })}\n`;
}

function turn(ts: string, attributes: Record<string, unknown>): ParsedTelemetryRecord {
	return { ts, name: "assistant_turn_completed", attributes };
}

describe("nearestRankPercentile", () => {
	it("picks the ceil(p/100 * n)-th smallest value", () => {
		expect(nearestRankPercentile([3, 1, 2], 50)).toBe(2);
		expect(nearestRankPercentile([3, 1, 2], 95)).toBe(3);
		expect(nearestRankPercentile([1, 2, 3, 4], 50)).toBe(2);
		expect(nearestRankPercentile([1, 2, 3, 4], 95)).toBe(4);
		const oneToTwenty = Array.from({ length: 20 }, (_, i) => i + 1).reverse();
		expect(nearestRankPercentile(oneToTwenty, 50)).toBe(10);
		expect(nearestRankPercentile(oneToTwenty, 95)).toBe(19);
	});

	it("handles single values and empty input", () => {
		expect(nearestRankPercentile([42], 50)).toBe(42);
		expect(nearestRankPercentile([42], 95)).toBe(42);
		expect(nearestRankPercentile([], 50)).toBeUndefined();
	});
});

describe("parseTelemetryLine", () => {
	it("parses conforming event lines", () => {
		const parsed = parseTelemetryLine(eventLine("2026-09-26T10:00:00.000Z", "vault_searched", { results: 3 }));
		expect(parsed).toEqual({ ts: "2026-09-26T10:00:00.000Z", name: "vault_searched", attributes: { results: 3 } });
	});

	it("skips corrupt and non-conforming lines", () => {
		expect(parseTelemetryLine("")).toBeUndefined();
		expect(parseTelemetryLine("   ")).toBeUndefined();
		expect(parseTelemetryLine("not json")).toBeUndefined();
		expect(parseTelemetryLine("42")).toBeUndefined();
		expect(parseTelemetryLine("[]")).toBeUndefined();
		expect(parseTelemetryLine('{"ts":"2026-09-26T10:00:00.000Z","kind":"span","name":"x"}')).toBeUndefined();
		expect(parseTelemetryLine('{"kind":"event","name":"x"}')).toBeUndefined();
		expect(parseTelemetryLine('{"ts":"2026-09-26T10:00:00.000Z","kind":"event"}')).toBeUndefined();
		expect(parseTelemetryLine('{"ts":"2026-09-26T10:00:00.000Z","kind":"event","name":"x","attributes":5}')).toEqual({
			ts: "2026-09-26T10:00:00.000Z",
			name: "x",
			attributes: {},
		});
	});
});

describe("summarizeTelemetryStats", () => {
	const nowMs = new Date(2026, 8, 26, 12).getTime();

	function fullFixture(): ParsedTelemetryRecord[] {
		return [
			turn(localTs(2026, 9, 26, 12, 30), {
				model: "m1",
				provider: "p",
				stopReason: "stop",
				contextTokens: 1000,
				outputTokens: 100,
				totalTokens: 500,
				durationMs: 200,
			}),
			turn(localTs(2026, 9, 26, 0, 5), {
				model: "m2",
				provider: "p",
				stopReason: "stop",
				contextTokens: 2000,
				outputTokens: 300,
				totalTokens: 700,
				durationMs: 400,
			}),
			turn(localTs(2026, 9, 25, 23, 59), {
				model: "m1",
				provider: "p",
				stopReason: "stop",
				contextTokens: 500,
				outputTokens: 50,
				totalTokens: 500,
				durationMs: 100,
			}),
			turn(localTs(2026, 9, 18, 12), {
				model: "m1",
				provider: "p",
				stopReason: "stop",
				contextTokens: 100,
				outputTokens: 10,
				totalTokens: 100,
				durationMs: 30,
			}),
			{
				ts: localTs(2026, 9, 26, 9),
				name: "compaction_completed",
				attributes: { trigger: "manual", tokensBefore: 9000, tokensAfter: 2000 },
			},
			{
				ts: localTs(2026, 9, 26, 10),
				name: "compaction_completed",
				attributes: { trigger: "auto", tokensBefore: 150000, tokensAfter: 30000 },
			},
			{
				ts: localTs(2026, 9, 26, 8),
				name: "auto_retry_scheduled",
				attributes: { attempt: 1, maxAttempts: 3, delayMs: 500, error: "boom" },
			},
			{
				ts: localTs(2026, 9, 25, 20),
				name: "auto_retry_scheduled",
				attributes: { attempt: 3, maxAttempts: 3, delayMs: 2000, error: "boom" },
			},
			{ ts: localTs(2026, 9, 26, 7), name: "memory_lessons_injected", attributes: { count: 2, ids: ["a", "b"] } },
			{
				ts: localTs(2026, 9, 26, 7, 30),
				name: "memory_lessons_injected",
				attributes: { count: 1, ids: ["b", "c"] },
			},
			{ ts: localTs(2026, 9, 26, 6), name: "vault_searched", attributes: { results: 4 } },
			{ ts: localTs(2026, 9, 26, 6, 30), name: "vault_searched", attributes: { results: 0 } },
		];
	}

	it("aggregates per-day buckets over the last 7 local days, oldest first", () => {
		const summary = summarizeTelemetryStats(fullFixture(), { nowMs });
		expect(summary.perDay).toHaveLength(7);
		expect(summary.perDay[0]?.day).toBe("2026-09-20");
		expect(summary.perDay[6]?.day).toBe("2026-09-26");
		const today = summary.perDay[6];
		expect(today).toMatchObject({ turns: 2, outputTokens: 400, p50Ms: 200, p95Ms: 400, compactions: 2, retries: 1 });
		const yesterday = summary.perDay[5];
		expect(yesterday).toMatchObject({
			day: "2026-09-25",
			turns: 1,
			outputTokens: 50,
			p50Ms: 100,
			p95Ms: 100,
			compactions: 0,
			retries: 1,
		});
		for (let i = 0; i < 5; i++) {
			const row = summary.perDay[i];
			expect(row).toMatchObject({ turns: 0, outputTokens: 0, compactions: 0, retries: 0 });
			expect(row?.p50Ms).toBeUndefined();
			expect(row?.p95Ms).toBeUndefined();
		}
	});

	it("totals cover everything retained, including records older than the window", () => {
		const summary = summarizeTelemetryStats(fullFixture(), { nowMs });
		expect(summary.totals.turns).toBe(4);
		expect(summary.totals.outputTokens).toBe(460);
		expect(summary.totals.avgContextTokens).toBe(900);
		expect(summary.totals.maxContextTokens).toBe(2000);
		// durations sorted [30, 100, 200, 400]: p50 is rank 2, p95 is rank 4
		expect(summary.totals.p50Ms).toBe(100);
		expect(summary.totals.p95Ms).toBe(400);
		expect(summary.totals.compactions).toBe(2);
		expect(summary.totals.compactionsByTrigger).toEqual({ manual: 1, auto: 1 });
		expect(summary.totals.retries).toBe(2);
		expect(summary.totals.maxRetryAttempt).toBe(3);
		expect(summary.totals.memoryLessonsInjected).toBe(3);
		expect(summary.totals.distinctMemoryLessonIds).toBe(3);
		expect(summary.totals.vaultSearches).toBe(2);
	});

	it("ranks models by total tokens and caps the list at five", () => {
		const summary = summarizeTelemetryStats(fullFixture(), { nowMs });
		expect(summary.models).toEqual([
			{ model: "m1", totalTokens: 1100 },
			{ model: "m2", totalTokens: 700 },
		]);
		const many = ["m1", "m2", "m3", "m4", "m5", "m6"].map((model, i) =>
			turn(localTs(2026, 9, 26, 8, i), { model, totalTokens: (i + 1) * 100 }),
		);
		expect(summarizeTelemetryStats(many, { nowMs }).models.map((entry) => entry.model)).toEqual([
			"m6",
			"m5",
			"m4",
			"m3",
			"m2",
		]);
	});

	it("splits records either side of local midnight into different day buckets", () => {
		const records: ParsedTelemetryRecord[] = [
			turn(localTs(2026, 9, 25, 23, 59, 59, 999), { model: "m1", outputTokens: 1, durationMs: 10 }),
			turn(localTs(2026, 9, 26, 0, 0, 0, 0), { model: "m1", outputTokens: 2, durationMs: 20 }),
			{ ts: "not-a-date", name: "vault_searched", attributes: {} },
		];
		const summary = summarizeTelemetryStats(records, { nowMs });
		expect(summary.perDay[5]).toMatchObject({ day: "2026-09-25", turns: 1, outputTokens: 1 });
		expect(summary.perDay[6]).toMatchObject({ day: "2026-09-26", turns: 1, outputTokens: 2 });
		// a record with an unparseable timestamp still reaches the totals
		expect(summary.totals.vaultSearches).toBe(1);
	});

	it("renders totals when every record is older than the window", () => {
		const records = [
			turn(localTs(2026, 8, 20, 12), { model: "m1", outputTokens: 5, totalTokens: 50, durationMs: 10 }),
			turn(localTs(2026, 8, 21, 12), { model: "m1", outputTokens: 7, totalTokens: 70, durationMs: 20 }),
		];
		const summary = summarizeTelemetryStats(records, { nowMs });
		expect(summary.totals.turns).toBe(2);
		expect(summary.perDay.every((row) => row.turns === 0)).toBe(true);
		const report = renderStatsReport(summary);
		expect(report).toContain("totals (retained)");
		expect(report).toContain("top models");
	});
});

describe("renderStatsReport", () => {
	it("renders the exact aligned table shape", () => {
		const summary = summarizeTelemetryStats(
			[
				turn(localTs(2026, 9, 26, 12, 30), {
					model: "m1",
					contextTokens: 1000,
					outputTokens: 100,
					totalTokens: 500,
					durationMs: 200,
				}),
			],
			{ nowMs: new Date(2026, 8, 26, 12).getTime() },
		);
		const expected = [
			"per day, last 7 days",
			"date        turns  out tok  p50 ms  p95 ms  compact  retries",
			"2026-09-20  0      0        -       -       0        0",
			"2026-09-21  0      0        -       -       0        0",
			"2026-09-22  0      0        -       -       0        0",
			"2026-09-23  0      0        -       -       0        0",
			"2026-09-24  0      0        -       -       0        0",
			"2026-09-25  0      0        -       -       0        0",
			"2026-09-26  1      100      200     200     0        0",
			"",
			"totals (retained)",
			"turns        1",
			"out tokens   100",
			"context tok  avg 1000, max 1000",
			"duration ms  p50 200, p95 200",
			"compactions  0",
			"retries      0",
			"",
			"top models",
			"m1  500",
			"",
			"memory",
			"lessons injected 0 (0 distinct), vault searches 0",
		].join("\n");
		expect(renderStatsReport(summary)).toBe(expected);
	});
});

describe("readTelemetryRecords", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hummin-stats-io-"));
		vi.stubEnv("HUMMIN_TELEMETRY_DIR", dir);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("yields [] for a missing directory", () => {
		expect(readTelemetryRecords(join(dir, "absent"))).toEqual([]);
	});

	it("skips corrupt lines and reads at most the 30 newest files", () => {
		const base = new Date(2026, 8, 26, 0).getTime();
		for (let i = 0; i < STATS_MAX_FILES + 1; i++) {
			const path = join(dir, `f${String(i).padStart(2, "0")}.jsonl`);
			const stamp = localTs(2026, 9, 26, 0, i);
			writeFileSync(path, `${eventLine(stamp, `ev${i}`, { i })}corrupt line\n{broken\n`);
			const mtime = new Date(base + i * 60_000);
			utimesSync(path, mtime, mtime);
		}
		const records = readTelemetryRecords(dir);
		expect(records).toHaveLength(STATS_MAX_FILES);
		const names = records.map((record) => record.name);
		expect(names).not.toContain("ev0");
		expect(names).toContain("ev1");
		expect(names).toContain(`ev${STATS_MAX_FILES}`);
		expect(records.every((record) => record.attributes.i !== undefined)).toBe(true);
	});

	it("reads only the tail of an oversized file", () => {
		const padding = "x".repeat(STATS_MAX_FILE_BYTES + 20);
		writeFileSync(
			join(dir, "big.jsonl"),
			`${padding}\n${eventLine(localTs(2026, 9, 26, 5), "tail_event", { ok: true })}`,
		);
		const records = readTelemetryRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.name).toBe("tail_event");
		expect(records[0]?.attributes).toEqual({ ok: true });
	});
});

// --- Command wiring -----------------------------------------------------------

function fakeStatsPi(): {
	api: ExtensionAPI;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
} {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const api = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
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

describe("/stats command", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hummin-stats-cmd-"));
		vi.stubEnv("HUMMIN_TELEMETRY_DIR", dir);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("registers with a handler that resolves the redirected telemetry dir", async () => {
		const { api, commands } = fakeStatsPi();
		humminStats(api);
		expect(commands.get("stats")).toBeDefined();
	});

	it("notifies exactly the empty message for a missing, empty, or corrupt-only directory", async () => {
		const { api, commands } = fakeStatsPi();
		humminStats(api);
		const command = commands.get("stats");
		if (!command) throw new Error("stats command not registered");
		const notified: string[] = [];
		await command.handler("", fakeCtx(notified));
		expect(notified).toEqual([EMPTY_STATS_MESSAGE]);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "junk.jsonl"), "not json\n{broken\n");
		const again: string[] = [];
		await command.handler("", fakeCtx(again));
		expect(again).toEqual([EMPTY_STATS_MESSAGE]);
	});

	it("renders the digest for recorded telemetry", async () => {
		const { api, commands } = fakeStatsPi();
		humminStats(api);
		const command = commands.get("stats");
		if (!command) throw new Error("stats command not registered");
		const now = new Date();
		writeFileSync(
			join(dir, "s1.jsonl"),
			eventLine(now.toISOString(), "assistant_turn_completed", {
				model: "m1",
				provider: "p",
				stopReason: "stop",
				contextTokens: 1000,
				outputTokens: 100,
				totalTokens: 500,
				durationMs: 200,
			}) +
				eventLine(now.toISOString(), "compaction_completed", {
					trigger: "manual",
					tokensBefore: 9000,
					tokensAfter: 2000,
				}) +
				eventLine(now.toISOString(), "memory_lessons_injected", { count: 2, ids: ["a", "b"] }),
		);
		const notified: string[] = [];
		await command.handler("", fakeCtx(notified));
		expect(notified).toHaveLength(1);
		const text = notified[0] ?? "";
		expect(text).toContain("per day, last 7 days");
		expect(text).toContain("totals (retained)");
		expect(text).toContain("compactions  1 (manual 1)");
		expect(text).toContain("m1  500");
		expect(text).toContain("lessons injected 2 (2 distinct), vault searches 0");
	});
});
