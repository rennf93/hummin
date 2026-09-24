// hummin friction log: one JSON line per notable friction event (tool errors,
// policy denials, circuit breaker trips, loop denials, bashguard advisories,
// LSP offline stub calls). Written to <agentDir>/friction.log, size-capped
// (past ~1MB the oldest half is dropped on the next append). All I/O is
// fail-silent: instrumentation must never break the host tool path. The
// parsing and summarizing helpers are pure and unit-testable.
import { Buffer } from "node:buffer";
import {
	appendFileSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type FrictionKind =
	| "tool_error"
	| "tool_rejected"
	| "circuit_breaker"
	| "loop_detected"
	| "advisory"
	| "lsp_stub";

export const FRICTION_KINDS: readonly FrictionKind[] = [
	"tool_error",
	"tool_rejected",
	"circuit_breaker",
	"loop_detected",
	"advisory",
	"lsp_stub",
];

export interface FrictionEvent {
	ts: string;
	kind: FrictionKind;
	source: string;
	detail?: string;
}

export interface FrictionSummary {
	total: number;
	byKind: Record<FrictionKind, number>;
	bySource: Record<string, number>;
	/** Local-day buckets, oldest first, covering the last `days` days. */
	perDay: { day: string; count: number }[];
}

export type LayaGateEntryType = "block" | "confirmed" | "read";

export interface LayaGateSummary {
	block: number;
	confirmed: number;
	read: number;
}

export const LAYA_GATE_ENTRY_TYPES: readonly LayaGateEntryType[] = ["block", "confirmed", "read"];

/** Default day window for per-day buckets. */
export const FRICTION_SUMMARY_DAYS = 7;
/** Detail strings are bounded so a huge advisory cannot bloat the log. */
export const FRICTION_DETAIL_MAX_CHARS = 200;
/** Soft cap for friction.log; the oldest half is dropped past it. */
export const FRICTION_LOG_MAX_BYTES = 1_000_000;
/** Reader bound: parse at most the tail of an oversized log. */
const READ_LIMIT_BYTES = 4_000_000;

export function frictionLogPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "friction.log");
}

export function layaGateLogPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "laya-gate.log");
}

/** Clamp a detail string; empty or undefined stays undefined. */
export function boundDetail(detail: string | undefined, maxChars: number = FRICTION_DETAIL_MAX_CHARS): string | undefined {
	if (detail === undefined || detail === "") return undefined;
	return detail.slice(0, maxChars);
}

/**
 * Append one friction event. Never throws: a broken or unwritable log must
 * not affect the tool path being instrumented.
 */
export function appendFriction(
	entry: { kind: FrictionKind; source: string; detail?: string },
	logPath: string = frictionLogPath(),
): void {
	try {
		const event: FrictionEvent = { ts: new Date().toISOString(), kind: entry.kind, source: entry.source };
		const detail = boundDetail(entry.detail);
		if (detail !== undefined) event.detail = detail;
		mkdirSync(dirname(logPath), { recursive: true });
		truncateOldestHalf(logPath);
		appendFileSync(logPath, `${JSON.stringify(event)}\n`);
	} catch {
		// fail-silent by contract
	}
}

/** Past the size cap, drop the oldest half (the cut lands on a line break). */
function truncateOldestHalf(logPath: string, maxBytes: number = FRICTION_LOG_MAX_BYTES): void {
	let size: number;
	try {
		size = statSync(logPath).size;
	} catch {
		return; // no log yet
	}
	if (size <= maxBytes) return;
	const text = readFileSync(logPath, "utf8");
	const cut = text.indexOf("\n", Math.floor(text.length / 2));
	if (cut === -1) return; // single oversized line: leave it alone
	writeFileSync(logPath, text.slice(cut + 1));
}

/** Tolerant line parser: corrupt or non-conforming lines yield undefined. */
export function parseFrictionLine(line: string): FrictionEvent | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.ts !== "string" || typeof record.source !== "string") return undefined;
		if (typeof record.kind !== "string" || !FRICTION_KINDS.includes(record.kind as FrictionKind)) return undefined;
		const event: FrictionEvent = { ts: record.ts, kind: record.kind as FrictionKind, source: record.source };
		if (typeof record.detail === "string" && record.detail !== "") event.detail = record.detail;
		return event;
	} catch {
		return undefined;
	}
}

/**
 * Read friction events from the last `days` days (days <= 0 reads everything).
 * Corrupt lines are skipped and at most the last READ_LIMIT_BYTES of the log
 * is parsed. A missing or unreadable log yields [].
 */
export function readFrictionEvents(days: number, logPath: string = frictionLogPath()): FrictionEvent[] {
	let events: FrictionEvent[];
	try {
		events = readLogTail(logPath, READ_LIMIT_BYTES)
			.split("\n")
			.map((line) => parseFrictionLine(line))
			.filter((event): event is FrictionEvent => event !== undefined);
	} catch {
		return [];
	}
	if (days <= 0) return events;
	const cutoff = Date.now() - days * 86_400_000;
	return events.filter((event) => {
		const time = Date.parse(event.ts);
		return Number.isNaN(time) || time >= cutoff;
	});
}

/** Bounded read: at most the last limitBytes of the file. */
function readLogTail(logPath: string, limitBytes: number): string {
	const fd = openSync(logPath, "r");
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

/** Local calendar day key (YYYY-MM-DD) for a timestamp. */
function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Summarize friction events: totals per kind (zero-filled for stable
 * rendering), totals per source, and per-day counts for the last `days` days
 * ending at `nowMs` (local calendar days, oldest first, zero-filled). Events
 * with timestamps outside the window or unparseable still count towards the
 * totals; only per-day is windowed.
 */
export function summarizeFriction(
	events: readonly FrictionEvent[],
	opts: { days?: number; nowMs?: number } = {},
): FrictionSummary {
	const nowMs = opts.nowMs ?? Date.now();
	const days = Math.max(1, Math.floor(opts.days ?? FRICTION_SUMMARY_DAYS));
	const byKind = Object.fromEntries(FRICTION_KINDS.map((kind) => [kind, 0])) as Record<FrictionKind, number>;
	const bySource = new Map<string, number>();
	for (const event of events) {
		if (FRICTION_KINDS.includes(event.kind)) byKind[event.kind] += 1;
		bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
	}
	// Anchor on today's local midnight and walk back with setDate so DST
	// transitions stay aligned to calendar days.
	const anchor = new Date(nowMs);
	anchor.setHours(0, 0, 0, 0);
	const keys: string[] = [];
	const counts = new Map<string, number>();
	for (let offset = days - 1; offset >= 0; offset--) {
		const date = new Date(anchor);
		date.setDate(date.getDate() - offset);
		const key = dayKey(date.getTime());
		keys.push(key);
		counts.set(key, 0);
	}
	for (const event of events) {
		const time = Date.parse(event.ts);
		if (Number.isNaN(time)) continue;
		const key = dayKey(time);
		const current = counts.get(key);
		if (current !== undefined) counts.set(key, current + 1);
	}
	return {
		total: events.length,
		byKind,
		bySource: Object.fromEntries(bySource),
		perDay: keys.map((day) => ({ day, count: counts.get(day) ?? 0 })),
	};
}

/** Parse one laya-gate.log line down to its entry type; undefined otherwise. */
export function parseLayaGateLine(line: string): LayaGateEntryType | undefined {
	return parseLayaGateEntry(line)?.type;
}

export interface LayaGateEntry {
	ts?: string;
	type: LayaGateEntryType;
	/** "read" entries only: steer | gate | decide | triage | intake. */
	kind?: string;
	/** Blocks, joined confirmations, and reads carry a 0..1 score. */
	p?: number;
	/** Block and confirmation entries carry the command. */
	command?: string;
}

/** Parse one laya-gate.log line into its useful fields; undefined otherwise. */
export function parseLayaGateEntry(line: string): LayaGateEntry | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		const type = record.type;
		if (typeof type !== "string" || !LAYA_GATE_ENTRY_TYPES.includes(type as LayaGateEntryType)) return undefined;
		const entry: LayaGateEntry = { type: type as LayaGateEntryType };
		if (typeof record.ts === "string") entry.ts = record.ts;
		if (typeof record.kind === "string") entry.kind = record.kind;
		if (typeof record.p === "number") entry.p = record.p;
		if (typeof record.command === "string") entry.command = record.command;
		return entry;
	} catch {
		return undefined;
	}
}

/** Count laya gate entries by type. Corrupt and unknown lines are ignored. */
export function summarizeLayaGate(lines: readonly string[]): LayaGateSummary {
	const summary: LayaGateSummary = { block: 0, confirmed: 0, read: 0 };
	for (const line of lines) {
		const type = parseLayaGateLine(line);
		if (type !== undefined) summary[type] += 1;
	}
	return summary;
}

/** Raw laya-gate.log lines; a missing or unreadable log yields []. */
export function readLayaGateLines(logPath: string = layaGateLogPath()): string[] {
	try {
		return readLogTail(logPath, READ_LIMIT_BYTES)
			.split("\n")
			.filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}

export interface LayaCalibration {
	threshold: number;
	/** Blocks whose logged score is known. */
	blocks: number;
	/** Min/median/max of block scores; undefined while there are none. */
	blockP: { min: number; median: number; max: number } | undefined;
	/** Marker confirmations (a confirmed block is a proven false positive). */
	confirmed: number;
	/** Confirmations whose block score was joined from the matching block. */
	confirmedScores: number[];
	/** Gate reads that passed at/above the near-miss floor but below the
	 * threshold: the only signal that a threshold may be too high. */
	nearMisses: number;
	nearMissMax: number | undefined;
	/** Suggested layaGateThreshold setting, or undefined when the data does
	 * not suggest a change. Never auto-applied. */
	suggestedThreshold: number | undefined;
}

/**
 * Pure calibration view over laya-gate entries. The suggestion comes from
 * ground truth: a confirmed block was a false positive at its score, so the
 * lowest confirmed score the current threshold would still block is the
 * binding constraint; suggest just above it (capped at 0.99).
 */
export function summarizeLayaCalibration(
	entries: readonly LayaGateEntry[],
	opts: { threshold: number; nearMissFloor?: number },
): LayaCalibration {
	const threshold = opts.threshold;
	const floor = Math.min(opts.nearMissFloor ?? 0.5, threshold);
	const blockScores: number[] = [];
	const confirmedScores: number[] = [];
	let nearMisses = 0;
	let nearMissMax: number | undefined;
	for (const entry of entries) {
		if (entry.type === "block" && typeof entry.p === "number") {
			blockScores.push(entry.p);
		} else if (entry.type === "confirmed" && typeof entry.p === "number") {
			confirmedScores.push(entry.p);
		} else if (entry.type === "read" && entry.kind === "gate" && typeof entry.p === "number" && entry.p >= floor && entry.p < threshold) {
			nearMisses += 1;
			nearMissMax = nearMissMax === undefined || entry.p > nearMissMax ? entry.p : nearMissMax;
		}
	}
	blockScores.sort((a, b) => a - b);
	const binding = confirmedScores.filter((p) => p >= threshold).sort((a, b) => a - b)[0];
	return {
		threshold,
		blocks: blockScores.length,
		blockP:
			blockScores.length > 0
				? {
						min: blockScores[0],
						median: blockScores[Math.floor(blockScores.length / 2)],
						max: blockScores[blockScores.length - 1],
					}
				: undefined,
		confirmed: confirmedScores.length,
		confirmedScores,
		nearMisses,
		nearMissMax,
		suggestedThreshold:
			binding === undefined ? undefined : Math.min(0.99, Math.round((binding + 0.02) * 100) / 100),
	};
}
