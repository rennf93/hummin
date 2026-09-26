// hummin-stats: the /stats command. Reads the pi-telemetry JSONL records that
// hummin-telemetry.ts persists (assistant_turn_completed, compaction_completed,
// auto_retry_scheduled, memory_lessons_injected, vault_searched) and renders a
// compact digest: per-day turn/token/duration buckets for the last 7 days,
// totals over everything retained, top models by tokens, and memory injection
// activity. Aggregation is a pure function over parsed records (exported for
// tests); this file only parses, aggregates, renders, and registers the
// command. I/O is bounded: at most the 30 most recently modified .jsonl files,
// each read as a 1MB tail, corrupt lines skipped. Like /friction, rendering is
// plain aligned text; a missing or empty telemetry directory renders exactly
// "No telemetry recorded yet.".
import { Buffer } from "node:buffer";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Day window for the per-day buckets (totals cover everything retained). */
export const STATS_REPORT_DAYS = 7;
/** At most this many most-recently-modified record files are read. */
export const STATS_MAX_FILES = 30;
/** Per-file read bound: at most the tail of an oversized file is parsed. */
export const STATS_MAX_FILE_BYTES = 1_000_000;
/** Per-model rows shown, ranked by total tokens. */
export const STATS_TOP_MODELS = 5;
/** Rendered when the telemetry directory is missing or holds no records. */
export const EMPTY_STATS_MESSAGE = "No telemetry recorded yet.";

/** One parsed telemetry record: the fields /stats consumes. */
export interface ParsedTelemetryRecord {
	ts: string;
	name: string;
	attributes: Record<string, unknown>;
}

export interface StatsDayRow {
	day: string;
	turns: number;
	outputTokens: number;
	/** Nearest-rank percentiles over that day's turn durations; undefined with no turns. */
	p50Ms: number | undefined;
	p95Ms: number | undefined;
	compactions: number;
	retries: number;
}

export interface StatsTotals {
	turns: number;
	outputTokens: number;
	avgContextTokens: number | undefined;
	maxContextTokens: number | undefined;
	p50Ms: number | undefined;
	p95Ms: number | undefined;
	compactions: number;
	compactionsByTrigger: Record<string, number>;
	retries: number;
	maxRetryAttempt: number | undefined;
	memoryLessonsInjected: number;
	distinctMemoryLessonIds: number;
	vaultSearches: number;
}

export interface StatsSummary {
	/** Local-day buckets, oldest first, zero-filled, covering the last `days` days. */
	perDay: StatsDayRow[];
	totals: StatsTotals;
	/** Top models by total tokens, best first. */
	models: { model: string; totalTokens: number }[];
}

/** Tolerant line parser: corrupt or non-conforming lines yield undefined. */
export function parseTelemetryLine(line: string): ParsedTelemetryRecord | undefined {
	if (line.trim() === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.kind !== "event") return undefined;
		if (typeof record.ts !== "string" || typeof record.name !== "string") return undefined;
		const attributes =
			typeof record.attributes === "object" && record.attributes !== null && !Array.isArray(record.attributes)
				? (record.attributes as Record<string, unknown>)
				: {};
		return { ts: record.ts, name: record.name, attributes };
	} catch {
		return undefined;
	}
}

/** Nearest-rank percentile: the ceil(p/100 * n)-th value of the ascending sort. */
export function nearestRankPercentile(values: readonly number[], p: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1];
}

/** Local calendar day key (YYYY-MM-DD) for a timestamp. */
function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function attrNumber(attributes: Record<string, unknown>, key: string): number | undefined {
	const value = attributes[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function attrString(attributes: Record<string, unknown>, key: string): string | undefined {
	const value = attributes[key];
	return typeof value === "string" ? value : undefined;
}

interface DayAccumulator {
	day: string;
	turns: number;
	outputTokens: number;
	durations: number[];
	compactions: number;
	retries: number;
}

/**
 * Pure aggregation over parsed telemetry records. Totals cover every record
 * given (whatever the files retained); the per-day buckets are zero-filled
 * local calendar days for the last `days` days ending at `nowMs` (oldest
 * first), mirroring /friction. Records with unparseable timestamps still
 * count towards the totals; only the per-day buckets are windowed.
 */
export function summarizeTelemetryStats(
	records: readonly ParsedTelemetryRecord[],
	opts: { nowMs?: number; days?: number } = {},
): StatsSummary {
	const nowMs = opts.nowMs ?? Date.now();
	const days = Math.max(1, Math.floor(opts.days ?? STATS_REPORT_DAYS));
	// Anchor on today's local midnight and walk back with setDate so DST
	// transitions stay aligned to calendar days.
	const anchor = new Date(nowMs);
	anchor.setHours(0, 0, 0, 0);
	const dayOrder: string[] = [];
	const dayAccs = new Map<string, DayAccumulator>();
	for (let offset = days - 1; offset >= 0; offset--) {
		const date = new Date(anchor);
		date.setDate(date.getDate() - offset);
		const key = dayKey(date.getTime());
		dayOrder.push(key);
		dayAccs.set(key, { day: key, turns: 0, outputTokens: 0, durations: [], compactions: 0, retries: 0 });
	}
	const durations: number[] = [];
	const contextTokens: number[] = [];
	const modelTokens = new Map<string, number>();
	const compactionsByTrigger = new Map<string, number>();
	const lessonIds = new Set<string>();
	let turns = 0;
	let outputTokens = 0;
	let compactions = 0;
	let retries = 0;
	let maxRetryAttempt: number | undefined;
	let memoryLessonsInjected = 0;
	let vaultSearches = 0;

	for (const record of records) {
		const attrs = record.attributes;
		const time = Date.parse(record.ts);
		const dayAcc = Number.isNaN(time) ? undefined : dayAccs.get(dayKey(time));
		if (record.name === "assistant_turn_completed") {
			const out = attrNumber(attrs, "outputTokens");
			const duration = attrNumber(attrs, "durationMs");
			const context = attrNumber(attrs, "contextTokens");
			turns += 1;
			outputTokens += out ?? 0;
			if (duration !== undefined) durations.push(duration);
			if (context !== undefined) contextTokens.push(context);
			const model = attrString(attrs, "model") ?? "unknown";
			modelTokens.set(model, (modelTokens.get(model) ?? 0) + (attrNumber(attrs, "totalTokens") ?? 0));
			if (dayAcc !== undefined) {
				dayAcc.turns += 1;
				dayAcc.outputTokens += out ?? 0;
				if (duration !== undefined) dayAcc.durations.push(duration);
			}
		} else if (record.name === "compaction_completed") {
			compactions += 1;
			const trigger = attrString(attrs, "trigger") ?? "unknown";
			compactionsByTrigger.set(trigger, (compactionsByTrigger.get(trigger) ?? 0) + 1);
			if (dayAcc !== undefined) dayAcc.compactions += 1;
		} else if (record.name === "auto_retry_scheduled") {
			retries += 1;
			const attempt = attrNumber(attrs, "attempt");
			if (attempt !== undefined && (maxRetryAttempt === undefined || attempt > maxRetryAttempt)) {
				maxRetryAttempt = attempt;
			}
			if (dayAcc !== undefined) dayAcc.retries += 1;
		} else if (record.name === "memory_lessons_injected") {
			memoryLessonsInjected += attrNumber(attrs, "count") ?? 0;
			const ids = attrs["ids"];
			if (Array.isArray(ids)) {
				for (const id of ids) {
					if (typeof id === "string") lessonIds.add(id);
				}
			}
		} else if (record.name === "vault_searched") {
			vaultSearches += 1;
		}
	}

	const perDay: StatsDayRow[] = dayOrder.map((key) => {
		const acc = dayAccs.get(key);
		const dayDurations = acc?.durations ?? [];
		return {
			day: key,
			turns: acc?.turns ?? 0,
			outputTokens: acc?.outputTokens ?? 0,
			p50Ms: nearestRankPercentile(dayDurations, 50),
			p95Ms: nearestRankPercentile(dayDurations, 95),
			compactions: acc?.compactions ?? 0,
			retries: acc?.retries ?? 0,
		};
	});
	const models = [...modelTokens.entries()]
		.map(([model, total]) => ({ model, totalTokens: total }))
		.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
		.slice(0, STATS_TOP_MODELS);
	const contextAvg = contextTokens.length > 0 ? contextTokens.reduce((sum, n) => sum + n, 0) / contextTokens.length : undefined;
	return {
		perDay,
		totals: {
			turns,
			outputTokens,
			avgContextTokens: contextAvg,
			maxContextTokens: contextTokens.length > 0 ? Math.max(...contextTokens) : undefined,
			p50Ms: nearestRankPercentile(durations, 50),
			p95Ms: nearestRankPercentile(durations, 95),
			compactions,
			compactionsByTrigger: Object.fromEntries(compactionsByTrigger),
			retries,
			maxRetryAttempt,
			memoryLessonsInjected,
			distinctMemoryLessonIds: lessonIds.size,
			vaultSearches,
		},
		models,
	};
}

/** Aligned multi-column table: every cell padded to its column width. */
function formatTable(rows: ReadonlyArray<readonly string[]>): string {
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, column) => {
			widths[column] = Math.max(widths[column] ?? 0, cell.length);
		});
	}
	return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n");
}

/** /doctor-style aligned two-column rows, as in /friction. */
function formatLabelRows(rows: ReadonlyArray<readonly [string, string]>): string {
	const width = Math.max(...rows.map(([label]) => label.length));
	return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

function totalsRows(totals: StatsTotals): ReadonlyArray<readonly [string, string]> {
	const rows: Array<readonly [string, string]> = [
		["turns", String(totals.turns)],
		["out tokens", String(totals.outputTokens)],
	];
	if (totals.avgContextTokens !== undefined) {
		rows.push(["context tok", `avg ${Math.round(totals.avgContextTokens)}, max ${totals.maxContextTokens ?? 0}`]);
	}
	if (totals.p50Ms !== undefined || totals.p95Ms !== undefined) {
		rows.push(["duration ms", `p50 ${totals.p50Ms ?? "-"}, p95 ${totals.p95Ms ?? "-"}`]);
	}
	const triggerParts = Object.entries(totals.compactionsByTrigger).map(([trigger, count]) => `${trigger} ${count}`);
	rows.push(["compactions", triggerParts.length > 0 ? `${totals.compactions} (${triggerParts.join(", ")})` : String(totals.compactions)]);
	rows.push([
		"retries",
		totals.maxRetryAttempt !== undefined ? `${totals.retries} (max attempt ${totals.maxRetryAttempt})` : String(totals.retries),
	]);
	return rows;
}

/** Plain-text /stats report. Pure; exported for tests. */
export function renderStatsReport(summary: StatsSummary): string {
	const dayHeader = ["date", "turns", "out tok", "p50 ms", "p95 ms", "compact", "retries"];
	const dayRows = summary.perDay.map((row): string[] => [
		row.day,
		String(row.turns),
		String(row.outputTokens),
		row.p50Ms === undefined ? "-" : String(row.p50Ms),
		row.p95Ms === undefined ? "-" : String(row.p95Ms),
		String(row.compactions),
		String(row.retries),
	]);
	const sections = [
		`per day, last ${summary.perDay.length} days`,
		formatTable([dayHeader, ...dayRows]),
		"",
		"totals (retained)",
		formatLabelRows(totalsRows(summary.totals)),
		"",
		"top models",
		summary.models.length > 0
			? formatLabelRows(summary.models.map((entry) => [entry.model, String(entry.totalTokens)] as const))
			: "none",
		"",
		"memory",
		`lessons injected ${summary.totals.memoryLessonsInjected} (${summary.totals.distinctMemoryLessonIds} distinct), vault searches ${summary.totals.vaultSearches}`,
	];
	return sections.join("\n");
}

/** Telemetry directory, resolved like hummin-telemetry.ts: env beats <agentDir>. */
export function telemetryDir(): string {
	return process.env.HUMMIN_TELEMETRY_DIR?.trim() || join(getAgentDir(), "telemetry");
}

/** Bounded read: at most the last limitBytes of the file. */
function readTail(path: string, limitBytes: number): string {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - limitBytes);
		const buffer = Buffer.alloc(size - start);
		let read = 0;
		while (read < buffer.length) {
			const bytes = readSync(fd, buffer, read, buffer.length - read, start + read);
			if (bytes <= 0) break;
			read += bytes;
		}
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Read telemetry records from a sink directory: at most the `maxFiles` most
 * recently modified .jsonl files, each parsed from at most the last
 * `maxFileBytes` bytes. A missing or unreadable directory yields [], and
 * corrupt lines are skipped.
 */
export function readTelemetryRecords(
	directory: string,
	maxFiles: number = STATS_MAX_FILES,
	maxFileBytes: number = STATS_MAX_FILE_BYTES,
): ParsedTelemetryRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return []; // directory does not exist yet
	}
	const files: { name: string; mtimeMs: number }[] = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const stat = statSync(join(directory, name));
			if (stat.isFile()) files.push({ name, mtimeMs: stat.mtimeMs });
		} catch {
			// File vanished between readdir and stat; ignore it.
		}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const records: ParsedTelemetryRecord[] = [];
	for (const file of files.slice(0, maxFiles)) {
		let text: string;
		try {
			text = readTail(join(directory, file.name), maxFileBytes);
		} catch {
			continue; // unreadable file; keep going
		}
		for (const line of text.split("\n")) {
			const parsed = parseTelemetryLine(line);
			if (parsed !== undefined) records.push(parsed);
		}
	}
	return records;
}

export default function humminStats(pi: ExtensionAPI): void {
	pi.registerCommand("stats", {
		description: "Show telemetry stats (turns, tokens, compactions, retries, memory) from the last 7 days",
		category: "Usage",
		handler: async (_args, ctx: ExtensionContext) => {
			const records = readTelemetryRecords(telemetryDir());
			if (records.length === 0) {
				ctx.ui.notify(EMPTY_STATS_MESSAGE, "info");
				return;
			}
			ctx.ui.notify(renderStatsReport(summarizeTelemetryStats(records)), "info");
		},
	});
}
