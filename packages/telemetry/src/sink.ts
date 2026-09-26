import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SpanAttributes } from "./index.ts";

// ============================================================================
// Event sink contract and process-wide registry
// ============================================================================

/** One point-in-time telemetry record. JSONL sinks serialize it as one line. */
export interface TelemetryEventRecord {
	/** ISO 8601 timestamp of when the event was emitted. */
	readonly ts: string;
	/** Record kind. Only point-in-time events exist today; span records may follow. */
	readonly kind: "event";
	/** Event name, e.g. "assistant_turn_completed". */
	readonly name: string;
	/** Small attribute payload. Undefined values are stripped before writing. */
	readonly attributes: SpanAttributes;
}

/** A destination for telemetry event records. Writes must never throw. */
export interface TelemetryEventSink {
	write(record: TelemetryEventRecord): void;
}

let activeEventSink: TelemetryEventSink | undefined;

/** Install the process-wide event sink, replacing any previous one. Pass undefined to remove. */
export function setTelemetryEventSink(sink: TelemetryEventSink | undefined): void {
	activeEventSink = sink;
}

/** The currently installed process-wide event sink, if any. */
export function getTelemetryEventSink(): TelemetryEventSink | undefined {
	return activeEventSink;
}

function cleanAttributes(attributes: SpanAttributes | undefined): SpanAttributes {
	const cleaned: SpanAttributes = {};
	if (!attributes) return cleaned;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) cleaned[name] = Array.isArray(value) ? [...value] : value;
	}
	return cleaned;
}

/**
 * Emit one point-in-time event to the installed sink. A no-op when no sink is
 * installed, and never throws: instrumentation must not break the emitting path.
 */
export function emitTelemetryEvent(name: string, attributes?: SpanAttributes): void {
	const sink = activeEventSink;
	if (!sink) return;
	try {
		sink.write({ ts: new Date().toISOString(), kind: "event", name, attributes: cleanAttributes(attributes) });
	} catch {
		// Fail-open by contract.
	}
}

// ============================================================================
// JSONL file sink
// ============================================================================

/**
 * Soft cap for the total size of the sink directory's record files. Once the
 * next write would push the total past it, the oldest files (by modification
 * time) are deleted until the total fits again. The active file is never
 * deleted; a single file that alone exceeds the cap is left alone, matching
 * the fail-open spirit of the friction log cap.
 */
export const TELEMETRY_LOG_MAX_BYTES = 1_000_000;

export interface FileTelemetryEventSinkOptions {
	/** Directory holding the record files. Created lazily on first write. */
	directory: string;
	/** File name of the active JSONL file, e.g. "<session-id>.jsonl". */
	fileName: string;
	/** Total size cap across all record files in the directory. */
	maxTotalBytes?: number;
}

/**
 * JSONL telemetry event sink: one JSON object per line, appended and flushed
 * per event. The directory is created lazily and every write is fail-open, so
 * a broken or unwritable destination never affects the instrumented path.
 */
export class FileTelemetryEventSink implements TelemetryEventSink {
	readonly path: string;
	private readonly directory: string;
	private readonly maxTotalBytes: number;

	constructor(options: FileTelemetryEventSinkOptions) {
		this.directory = options.directory;
		this.path = join(options.directory, options.fileName);
		this.maxTotalBytes = options.maxTotalBytes ?? TELEMETRY_LOG_MAX_BYTES;
	}

	write(record: TelemetryEventRecord): void {
		try {
			const line = `${JSON.stringify(record)}\n`;
			mkdirSync(this.directory, { recursive: true });
			this.rotateOtherFiles(line.length);
			appendFileSync(this.path, line);
		} catch {
			// Fail-open by contract: recording must never break the emitting path.
		}
	}

	/** Delete oldest record files while the incoming line would exceed the cap. */
	private rotateOtherFiles(incomingBytes: number): void {
		let entries: string[];
		try {
			entries = readdirSync(this.directory);
		} catch {
			return; // directory does not exist yet
		}
		const activeName = this.path.slice(this.directory.length + 1);
		const files: { name: string; size: number; mtimeMs: number }[] = [];
		let total = 0;
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			try {
				const stat = statSync(join(this.directory, name));
				if (!stat.isFile()) continue;
				files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
				total += stat.size;
			} catch {
				// File vanished between readdir and stat; ignore it.
			}
		}
		if (total + incomingBytes <= this.maxTotalBytes) return;
		files.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const file of files) {
			if (total + incomingBytes <= this.maxTotalBytes) break;
			if (file.name === activeName) continue;
			try {
				unlinkSync(join(this.directory, file.name));
				total -= file.size;
			} catch {
				// Unreadable or already removed; keep going.
			}
		}
	}
}
