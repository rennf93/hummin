/**
 * harness/replay.test: pins the replay harness behavior: log seq assignment
 * and replay window edges, server consume and snapshot semantics, and the
 * protocol shape of the converted fixtures and the corruption corpus.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type AnyRemoteEvent,
	REPLAY_BUFFER_LIMIT,
	type RemoteEvent,
	type RemoteEventType,
	type ReplayEventInput,
	ReplayLog,
	type WireAgentMessage,
} from "./replay-log.ts";
import { ReplayServer } from "./replay-server.ts";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness");
const FIXTURES_DIR = join(HARNESS_DIR, "fixtures");
const CORPUS_DIR = join(HARNESS_DIR, "corpus");
const TEST_TS = "2026-01-01T00:00:00.000Z";
const OVERSIZE_LIMIT = 8000;

const FIXTURE_NAMES = [
	"hummin-longest",
	"hummin-longest.stream",
	"hummin-mid",
	"hummin-tiny",
	"other---Users-renzof-Documents",
];
const CORPUS_FILES = [
	"bad-tool-call.json",
	"broken-unicode.txt",
	"giant-args.json",
	"markdown-bomb.md",
	"mixed-marks.json",
	"oversize.txt",
];

const REMOTE_EVENT_TYPES: readonly RemoteEventType[] = [
	"snapshot",
	"message_start",
	"message_delta",
	"message_end",
	"tool_update",
	"status",
	"approval",
	"approval_done",
	"queue",
	"session",
	"ping",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Trust boundary: fixture and corpus files are parsed JSON from disk. Checks the
 * event envelope and, for snapshots, the payload envelope the tests rely on;
 * deeper field checks live in the tests themselves. */
function assertRemoteEvents(value: unknown, label: string): AnyRemoteEvent[] {
	if (!Array.isArray(value)) throw new Error(`${label}: expected an event array`);
	for (const [index, raw] of value.entries()) {
		const where = `${label}[${index}]`;
		if (!isRecord(raw)) throw new Error(`${where}: event is not an object`);
		if (raw.v !== 1) throw new Error(`${where}: expected protocol v1`);
		if (typeof raw.seq !== "number") throw new Error(`${where}: seq is not a number`);
		if (typeof raw.ts !== "string") throw new Error(`${where}: ts is not a string`);
		if (typeof raw.type !== "string" || !REMOTE_EVENT_TYPES.some((t) => t === raw.type)) {
			throw new Error(`${where}: unknown event type ${String(raw.type)}`);
		}
		if (!isRecord(raw.payload)) throw new Error(`${where}: payload is not an object`);
		if (raw.type === "snapshot") assertSnapshotEnvelope(raw.payload, where);
	}
	// Cast is sound: the envelope and snapshot shape were validated above and
	// Record narrowing cannot recover the protocol types.
	return value as AnyRemoteEvent[];
}

function assertSnapshotEnvelope(payload: Record<string, unknown>, where: string): void {
	const messages = payload.messages;
	if (!Array.isArray(messages)) throw new Error(`${where}: snapshot messages is not an array`);
	for (const [index, raw] of messages.entries()) {
		if (!isRecord(raw)) throw new Error(`${where}.messages[${index}]: entry is not an object`);
		if (typeof raw.entryId !== "string") throw new Error(`${where}.messages[${index}]: entryId is not a string`);
		if (!isRecord(raw.message)) throw new Error(`${where}.messages[${index}]: message is not an object`);
		if (!Array.isArray(raw.message.blocks)) throw new Error(`${where}.messages[${index}]: blocks is not an array`);
	}
}

interface ManifestEntry {
	name: string;
	source: string;
	messageCount: number;
	toolCallCount: number;
	maxBlockChars: number;
	oversizedBlocks: number;
}

function assertManifest(value: unknown): ManifestEntry[] {
	if (!Array.isArray(value)) throw new Error("manifest: expected an array");
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) throw new Error(`manifest[${index}]: not an object`);
		for (const key of ["name", "source"] as const) {
			if (typeof raw[key] !== "string") throw new Error(`manifest[${index}]: ${key} is not a string`);
		}
		for (const key of ["messageCount", "toolCallCount", "maxBlockChars", "oversizedBlocks"] as const) {
			if (typeof raw[key] !== "number") throw new Error(`manifest[${index}]: ${key} is not a number`);
		}
	}
	// Cast is sound: every declared field was type-checked above.
	return value as ManifestEntry[];
}

function loadEvents(dir: string, file: string): AnyRemoteEvent[] {
	const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
	return assertRemoteEvents(raw, file);
}

/** Narrows a protocol event by its type discriminator or fails loudly. */
function expectKind<K extends RemoteEventType>(event: AnyRemoteEvent, kind: K): RemoteEvent<K> {
	if (event.type !== kind) throw new Error(`expected ${kind}, got ${event.type}`);
	// Cast is sound: type is the discriminator of the AnyRemoteEvent union.
	return event as RemoteEvent<K>;
}

/** Widens the server's event type to its discriminated union form. */
function anyEvent(event: RemoteEvent): AnyRemoteEvent {
	// Cast is sound: AnyRemoteEvent is RemoteEvent's union form; consume returns
	// RemoteEvent[] per the SSE contract, and only the test needs narrowing.
	return event as AnyRemoteEvent;
}

function ping(seq: number): RemoteEvent {
	return { v: 1, seq, ts: TEST_TS, type: "ping", payload: {} };
}

function seqRange(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function tallyMessage(message: WireAgentMessage, stats: Stats): void {
	stats.messageCount++;
	for (const block of message.blocks) {
		if (block.type === "toolCall") stats.toolCallCount++;
		if (block.type === "text" || block.type === "thinking") {
			stats.maxBlockChars = Math.max(stats.maxBlockChars, block.text.length);
			if (block.text.length > OVERSIZE_LIMIT) stats.oversizedBlocks++;
		}
	}
}

interface Stats {
	messageCount: number;
	toolCallCount: number;
	maxBlockChars: number;
	oversizedBlocks: number;
}

/** Independent recount of the stats the manifest declares, over snapshot
 * messages and, for stream fixtures, the streamed message_end payload. */
function recount(events: AnyRemoteEvent[]): Stats {
	const stats: Stats = { messageCount: 0, toolCallCount: 0, maxBlockChars: 0, oversizedBlocks: 0 };
	for (const event of events) {
		if (event.type === "snapshot") {
			for (const entry of event.payload.messages) tallyMessage(entry.message, stats);
		} else if (event.type === "message_end") {
			tallyMessage(event.payload.message, stats);
		}
	}
	return stats;
}

function snapshotOf(events: AnyRemoteEvent[]): RemoteEvent<"snapshot"> {
	const first = expectKind(events[0], "snapshot");
	if (events.some((e) => e.type !== "snapshot" && e.type !== "ping")) {
		throw new Error("snapshot fixture must contain only the snapshot event and pings");
	}
	return first;
}

describe("ReplayLog", () => {
	it("assigns monotonic seq across appends and ignores caller seqs", () => {
		const log = new ReplayLog();
		const withCallerSeq: ReplayEventInput = { ...ping(0), seq: 999 };
		expect([log.append(ping(0)).seq, log.append(withCallerSeq).seq, log.append(ping(1)).seq]).toEqual([0, 1, 2]);
		expect(log.append(ping(2)).seq).toBe(3);
	});

	it("events_since replays strictly after the cursor", () => {
		const log = new ReplayLog();
		for (let i = 0; i < 10; i++) log.append(ping(i));
		// exact cursor: the event at the cursor is excluded, the rest are included
		expect(log.events_since(3)?.map((e) => e.seq)).toEqual(seqRange(4, 9));
		// one below the buffer start is not replayable
		expect(log.events_since(-1)).toBeUndefined();
		// cursor at the buffer start: everything except the cursor event itself
		expect(log.events_since(0)?.map((e) => e.seq)).toEqual(seqRange(1, 9));
		// cursor at the newest event and beyond it: empty window, still replayable
		expect(log.events_since(9)).toEqual([]);
		expect(log.events_since(10)).toEqual([]);
	});

	it("keeps the last 2000 events and drops the oldest without error", () => {
		const log = new ReplayLog();
		const total = REPLAY_BUFFER_LIMIT + 25;
		for (let i = 0; i < total; i++) log.append(ping(i));
		// seqs 0..24 were dropped: cursors below the new buffer start are stale
		expect(log.events_since(24)).toBeUndefined();
		const kept = log.events_since(25);
		expect(kept?.map((e) => e.seq)).toEqual(seqRange(26, total - 1));
	});
});

describe("ReplayServer", () => {
	it("consume flags needsSnapshot for absent and stale cursors", () => {
		// a log without a snapshot event: the SSE layer has nothing to serve
		const server = new ReplayServer(seqRange(0, 9).map((seq) => ping(seq)));
		expect(server.consume(undefined, 100)).toEqual({ events: [], needsSnapshot: true });
		expect(server.consume(-1, 100)).toEqual({ events: [], needsSnapshot: true });
		const fresh = server.consume(0, 100);
		expect(fresh.needsSnapshot).toBe(false);
		expect(fresh.events.map((e) => e.seq)).toEqual(seqRange(1, 9));
	});

	it("consume pages the replay window by count", () => {
		const server = new ReplayServer(seqRange(0, 9).map((seq) => ping(seq)));
		expect(server.consume(0, 3).events.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(server.consume(0, 0).events).toEqual([]);
		// a cursor beyond the newest event is caught up, not stale
		expect(server.consume(10, 5)).toEqual({ events: [], needsSnapshot: false });
	});

	it("consume serves the fixture snapshot when the cursor is absent or stale", () => {
		const server = new ReplayServer(loadEvents(FIXTURES_DIR, "hummin-longest.events.json"));
		const absent = server.consume(undefined, 10);
		expect(absent.needsSnapshot).toBe(true);
		expect(absent.events.map((e) => e.type)).toEqual(["snapshot"]);
		const stale = server.consume(-1, 10);
		expect(stale.needsSnapshot).toBe(true);
		expect(stale.events.map((e) => e.type)).toEqual(["snapshot"]);
	});

	it("consume of a real converted fixture returns a protocol-shaped snapshot", () => {
		const fixture = loadEvents(FIXTURES_DIR, "hummin-longest.events.json");
		const server = new ReplayServer(fixture);
		const { events } = server.consume(undefined, 10);
		const snapshot = expectKind(anyEvent(events[0]), "snapshot");
		const entryIds = new Set<string>();
		for (const entry of snapshot.payload.messages) {
			expect(entry.entryId).toMatch(/^fx-\d+$/);
			entryIds.add(entry.entryId);
			for (const block of entry.message.blocks) {
				if (block.type === "toolCall") {
					expect(block.id.length).toBeGreaterThan(0);
					expect(block.name.length).toBeGreaterThan(0);
					expect(block.arguments).toBeTypeOf("object");
				}
			}
		}
		expect(entryIds.size).toBe(snapshot.payload.messages.length);
	});

	it("simulateStream yields the snapshot then the stream variant in order", async () => {
		const fixture = loadEvents(FIXTURES_DIR, "hummin-longest.events.json");
		const stream = loadEvents(FIXTURES_DIR, "hummin-longest.stream.events.json");
		const server = new ReplayServer(fixture, { delayMs: 1 });
		const yielded: AnyRemoteEvent[] = [];
		for await (const event of server.simulateStream([...fixture, ...stream])) yielded.push(anyEvent(event));
		expect(yielded[0]?.type).toBe("snapshot");
		const streamEvents = yielded.filter(
			(e) => e.type === "message_start" || e.type === "message_delta" || e.type === "message_end",
		);
		expect(streamEvents.map((e) => e.type)).toEqual([
			"message_start",
			"message_delta",
			"message_delta",
			"message_end",
		]);
		const start = expectKind(streamEvents[0], "message_start");
		const deltas = streamEvents
			.filter((e) => e.type === "message_delta")
			.map((e) => expectKind(e, "message_delta").payload.event);
		const end = expectKind(streamEvents[3], "message_end");
		expect(deltas.length).toBeGreaterThanOrEqual(2);
		expect(deltas.every((d) => d.type === "text_delta")).toBe(true);
		expect(start.payload.slotKey).toBe(end.payload.slotKey);
		expect(end.payload.entryId).toMatch(/^fx-\d+$/);
		// the deltas reassemble the final text block of the streamed turn
		const joined = deltas.map((d) => (d.type === "text_delta" ? d.delta : "")).join("");
		const textIndex = end.payload.message.blocks.findIndex((b) => b.type === "text");
		const finalBlock = end.payload.message.blocks[textIndex];
		if (finalBlock?.type !== "text") throw new Error("message_end has no text block");
		expect(finalBlock.text).toBe(joined);
		// the streamed turn is the same recorded message the snapshot carries
		const snapshot = expectKind(fixture[0], "snapshot");
		const streamed = snapshot.payload.messages.find((entry) => entry.entryId === end.payload.entryId);
		if (!streamed) throw new Error("streamed entry missing from the snapshot");
		expect(streamed.message.blocks).toEqual(end.payload.message.blocks);
	});

	it("simulateStream honors delayMs", async () => {
		const server = new ReplayServer([], { delayMs: 2 });
		const events = seqRange(0, 2).map((seq) => ping(seq));
		const started = performance.now();
		const yielded: RemoteEvent[] = [];
		for await (const event of server.simulateStream(events)) yielded.push(event);
		expect(yielded).toHaveLength(3);
		// two inter-yield gaps of at least 2ms each
		expect(performance.now() - started).toBeGreaterThanOrEqual(4);
	});
});

describe("fixtures and corpus", () => {
	it("manifest matches the converted fixture files", () => {
		const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"));
		const manifest = assertManifest(raw);
		expect(manifest.map((m) => m.name).sort()).toEqual([...FIXTURE_NAMES].sort());
		for (const entry of manifest) {
			const events = loadEvents(FIXTURES_DIR, `${entry.name}.events.json`);
			if (entry.name.endsWith(".stream")) {
				expect(events.map((e) => e.type)).toEqual([
					"message_start",
					"message_delta",
					"message_delta",
					"message_end",
				]);
			} else {
				const snapshot = snapshotOf(events);
				// one synthesized ping per 100 transcript entries after the snapshot
				expect(events).toHaveLength(1 + Math.floor(entry.messageCount / 100));
				expect(snapshot.payload.messages).toHaveLength(entry.messageCount);
			}
			expect(recount(events)).toEqual({
				messageCount: entry.messageCount,
				toolCallCount: entry.toolCallCount,
				maxBlockChars: entry.maxBlockChars,
				oversizedBlocks: entry.oversizedBlocks,
			});
		}
		// the recorded sessions carry 2972 tool calls; conversion must not lose one
		const convertedCalls = manifest
			.filter((m) => !m.name.endsWith(".stream"))
			.reduce((sum, m) => sum + m.toolCallCount, 0);
		expect(convertedCalls).toBe(2972);
	});

	it("every corruption file parses and passes a structural check", () => {
		expect(readdirSync(CORPUS_DIR).sort()).toEqual(CORPUS_FILES);
		for (const file of CORPUS_FILES) {
			const events = loadEvents(CORPUS_DIR, file);
			expect(events).toHaveLength(1);
			const snapshot = expectKind(events[0], "snapshot");
			expect(snapshot.payload.messages.length).toBeGreaterThan(0);
		}
	});

	it("markdown-bomb stresses nesting, raw HTML, autolinks, a huge table, and unclosed fences", () => {
		const snapshot = expectKind(loadEvents(CORPUS_DIR, "markdown-bomb.md")[0], "snapshot");
		const text = snapshot.payload.messages
			.flatMap((entry) => entry.message.blocks)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");
		expect(text).toContain("      - level 6");
		expect(text).toContain("<script>");
		expect(text).toContain("<iframe");
		expect(text).toContain('onerror="');
		expect(text).toContain('href="javascript:');
		expect(text).toContain("https://example.com/a?b=1&c=2");
		expect(text).toContain("|---|---|---|");
		expect(text).toContain("| row 119 |");
		// exactly one unclosed backtick fence and one unclosed tilde fence
		expect((text.match(/```/g) ?? []).length).toBe(1);
		expect((text.match(/~~~/g) ?? []).length).toBe(1);
	});

	it("oversize carries a single 51318-char text block", () => {
		const snapshot = expectKind(loadEvents(CORPUS_DIR, "oversize.txt")[0], "snapshot");
		expect(snapshot.payload.messages).toHaveLength(1);
		expect(snapshot.payload.messages[0].message.blocks).toHaveLength(1);
		const block = snapshot.payload.messages[0].message.blocks[0];
		expect(block.type).toBe("text");
		if (block.type !== "text") throw new Error("expected a text block");
		expect(block.text).toHaveLength(51318);
	});

	it("broken-unicode carries lone surrogates, zero-width joins, and RTL overrides", () => {
		const snapshot = expectKind(loadEvents(CORPUS_DIR, "broken-unicode.txt")[0], "snapshot");
		const block = snapshot.payload.messages[0].message.blocks[0];
		if (block.type !== "text") throw new Error("expected a text block");
		expect(block.text.includes("\ud800")).toBe(true);
		expect(block.text.includes("\udfff")).toBe(true);
		expect(block.text.includes("\u200d")).toBe(true);
		expect(block.text.includes("\u202e")).toBe(true);
	});

	it("bad-tool-call carries a toolCall with argumentsError and empty arguments", () => {
		const snapshot = expectKind(loadEvents(CORPUS_DIR, "bad-tool-call.json")[0], "snapshot");
		const blocks = snapshot.payload.messages[0].message.blocks;
		const call = blocks.find((b) => b.type === "toolCall");
		if (!call || call.type !== "toolCall") throw new Error("expected a toolCall block");
		expect(call.arguments).toEqual({});
		expect(call.argumentsError).toBeTypeOf("string");
		expect(call.argumentsError?.length).toBeGreaterThan(0);
	});

	it("giant-args carries a toolCall argument string of 60000 chars", () => {
		const snapshot = expectKind(loadEvents(CORPUS_DIR, "giant-args.json")[0], "snapshot");
		const call = snapshot.payload.messages[0].message.blocks[0];
		if (call.type !== "toolCall") throw new Error("expected a toolCall block");
		const longest = Math.max(...Object.values(call.arguments).map((v) => (typeof v === "string" ? v.length : 0)));
		expect(longest).toBe(60000);
	});

	it("mixed-marks carries 40 toolResult entries alternating isError with durationMs", () => {
		const snapshot = expectKind(loadEvents(CORPUS_DIR, "mixed-marks.json")[0], "snapshot");
		const messages = snapshot.payload.messages.map((entry) => entry.message);
		expect(messages).toHaveLength(40);
		expect(messages.every((m) => m.role === "toolResult")).toBe(true);
		expect(messages.every((m) => typeof m.durationMs === "number")).toBe(true);
		expect(messages.map((m) => m.isError)).toEqual(seqRange(0, 39).map((i) => i % 2 === 1));
	});
});
