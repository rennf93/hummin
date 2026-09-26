import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	emitTelemetryEvent,
	FileTelemetryEventSink,
	getTelemetryEventSink,
	setTelemetryEventSink,
	type TelemetryEventRecord,
} from "../src/sink.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	setTelemetryEventSink(undefined);
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function sinkRecords(sink: FileTelemetryEventSink): TelemetryEventRecord[] {
	return readFileSync(sink.path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as TelemetryEventRecord);
}

describe("emitTelemetryEvent", () => {
	it("is a no-op when no sink is installed", () => {
		expect(getTelemetryEventSink()).toBeUndefined();
		expect(() => emitTelemetryEvent("event", { value: 1 })).not.toThrow();
	});

	it("writes one record per emit with ts, kind, name, and cleaned attributes", () => {
		const records: TelemetryEventRecord[] = [];
		setTelemetryEventSink({ write: (record) => records.push(record) });
		emitTelemetryEvent("assistant_turn_completed", {
			model: "m",
			totalTokens: 42,
			ignored: undefined,
			tags: ["a", "b"],
		});

		expect(records).toHaveLength(1);
		const record = records[0]!;
		expect(record.kind).toBe("event");
		expect(record.name).toBe("assistant_turn_completed");
		expect(typeof record.ts).toBe("string");
		expect(Number.isFinite(Date.parse(record.ts))).toBe(true);
		expect(record.attributes).toEqual({ model: "m", totalTokens: 42, tags: ["a", "b"] });
	});

	it("never throws when the sink throws", () => {
		setTelemetryEventSink({
			write: () => {
				throw new Error("disk full");
			},
		});
		expect(() => emitTelemetryEvent("event")).not.toThrow();
	});
});

describe("FileTelemetryEventSink", () => {
	it("creates the directory lazily and appends one JSON object per line", () => {
		const directory = join(makeTempDir(), "nested", "telemetry");
		const sink = new FileTelemetryEventSink({ directory, fileName: "session.jsonl" });
		expect(existsSync(directory)).toBe(false);

		sink.write({ ts: "t1", kind: "event", name: "first", attributes: { n: 1 } });
		sink.write({ ts: "t2", kind: "event", name: "second", attributes: {} });

		expect(existsSync(directory)).toBe(true);
		expect(sink.path).toBe(join(directory, "session.jsonl"));
		expect(sinkRecords(sink)).toEqual([
			{ ts: "t1", kind: "event", name: "first", attributes: { n: 1 } },
			{ ts: "t2", kind: "event", name: "second", attributes: {} },
		]);
	});

	it("deletes the oldest files by mtime when the total size cap is exceeded", () => {
		const directory = makeTempDir();
		const sink = new FileTelemetryEventSink({ directory, fileName: "active.jsonl", maxTotalBytes: 200 });
		const oldPath = join(directory, "old.jsonl");
		const newerPath = join(directory, "newer.jsonl");
		writeFileSync(oldPath, "x".repeat(90));
		writeFileSync(newerPath, "x".repeat(90));
		// Force distinct mtimes so ordering is deterministic even on fast filesystems.
		utimesSync(oldPath, new Date(1_000), new Date(1_000));
		utimesSync(newerPath, new Date(2_000), new Date(2_000));

		sink.write({ ts: "t", kind: "event", name: "push-over-cap", attributes: {} });

		expect(existsSync(oldPath)).toBe(false);
		expect(existsSync(newerPath)).toBe(true);
		expect(existsSync(sink.path)).toBe(true);
		expect(sinkRecords(sink)).toHaveLength(1);
	});

	it("never deletes the active file and leaves a lone oversized file alone", () => {
		const directory = makeTempDir();
		const sink = new FileTelemetryEventSink({ directory, fileName: "active.jsonl", maxTotalBytes: 10 });
		const bigLine = "x".repeat(50);

		sink.write({ ts: "t", kind: "event", name: "big", attributes: { pad: bigLine } });

		expect(existsSync(sink.path)).toBe(true);
		expect(readdirSync(directory)).toEqual(["active.jsonl"]);
	});

	it("swallows unwritable destinations instead of throwing", () => {
		const sink = new FileTelemetryEventSink({
			directory: join(makeTempDir(), "blocked", "deep"),
			fileName: "session.jsonl",
		});
		expect(() => sink.write({ ts: "t", kind: "event", name: "e", attributes: {} })).not.toThrow();
	});
});
