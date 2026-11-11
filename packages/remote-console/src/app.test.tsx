/**
 * app.test: Phase C shell verification. Covers the SSE frame parser (split
 * byte chunks, comments, multi-line data, CRLF, stream flush, a real fixture
 * through the byte pipeline), the fetch-based reconnect state machine (401
 * stop, backoff schedule and cap, reset on success, Last-Event-ID replay,
 * close), the per-host store reducer (snapshot, slot fold and dedupe,
 * coalesced-delta tolerance, tool updates, slice replacement), the browser
 * host registry and appearance store, and the App integration: regions, rail
 * rows, approval card posting through the mocked fetch, composer prompt
 * posting, preset switching, and the token never appearing in a URL.
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { App } from "./App.tsx";
import {
	connectSse,
	consumeStream,
	parseProtocolEvent,
	postApproval,
	postConsoleOrigin,
	SseFrameParser,
	type ConnectionState,
	type SseConnection,
	type SseFrame,
} from "./connection.ts";
import { ApprovalCard, countdownSeconds } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { HostRail, railStatus } from "./components/HostRail.tsx";
import { RollingNumber } from "./components/RollingNumber.tsx";
import { SlidingPill } from "./components/SlidingPill.tsx";
import type {
	AnyRemoteEvent,
	RemoteEventPayloadMap,
	RemoteEventType,
	SnapshotPayload,
	WireApproval,
	WireStatus,
	WireTranscriptEntry,
} from "./harness/replay-log.ts";
import {
	addHost,
	adoptLocalHost,
	applyAppearance,
	clampAccentHue,
	listHosts,
	loadAppearance,
	parseAppearance,
	parseHosts,
	removeHost,
	saveAppearance,
	updateHost,
	type Appearance,
} from "./hosts.ts";
import { mount, type Mounted } from "./renderer/test/mount.tsx";
import { TranscriptList } from "./renderer/transcript/TranscriptList.tsx";
import { initialHostState, reduceHosts, type HostStore } from "./store.ts";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "harness");
const FIXTURES_DIR = join(HARNESS_DIR, "fixtures");
const TS = "2026-01-01T00:00:00.000Z";

function makeEvent<K extends RemoteEventType>(type: K, seq: number, payload: RemoteEventPayloadMap[K]): AnyRemoteEvent {
	// The type/payload correlation holds by construction: the payload is typed
	// from the same key as the event type.
	return { v: 1, seq, ts: TS, type, payload } as AnyRemoteEvent;
}

function sseText(events: readonly AnyRemoteEvent[]): string {
	return events.map((event) => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Pull-based like a real fetch body. Node 22 drains a stream with every chunk
 * queued up front in quadratic time (244k chunks: 29s against 96ms pulled). */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	let next = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[next++];
			if (chunk === undefined) controller.close();
			else controller.enqueue(chunk);
		},
	});
}

/** Minimal response stand-in: connection.ts reads ok, status, and body only. */
function fakeResponse(init: { ok?: boolean; status?: number; body?: ReadableStream<Uint8Array> }): Response {
	return { ok: init.ok ?? false, status: init.status ?? 500, body: init.body ?? null } as unknown as Response;
}

interface RecordedFetch {
	url: string;
	init: RequestInit | undefined;
}

/** Never resolves: the connection stays in its first attempt forever. */
function hangingFetch(records: RecordedFetch[]): typeof fetch {
	const handler = (url: string | URL, init?: RequestInit): Promise<Response> => {
		records.push({ url: url.toString(), init });
		return new Promise<Response>(() => undefined);
	};
	return handler as unknown as typeof fetch;
}

/** An open stream: enqueues once and never closes, like a live SSE response. */
function liveStreamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
		},
	});
}

/** Serves the events over a live SSE stream and records POSTs. */
function consoleFetch(events: readonly AnyRemoteEvent[], posts: RecordedFetch[]): typeof fetch {
	const handler = (url: string | URL, init?: RequestInit): Promise<Response> => {
		const urlText = url.toString();
		if (urlText.endsWith("/events")) {
			const bytes = new TextEncoder().encode(sseText(events));
			return Promise.resolve(fakeResponse({ ok: true, status: 200, body: liveStreamOf([bytes]) }));
		}
		posts.push({ url: urlText, init });
		return Promise.resolve(fakeResponse({ ok: true, status: 202 }));
	};
	return handler as unknown as typeof fetch;
}

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TEST_HOST = { id: "h1", label: "main", origin: "http://127.0.0.1:9", token: "secret" };

/** Private-mode simulation: every localStorage write throws, like Safari
 * private mode or a full quota. happy-dom binds Storage methods onto the
 * instance (ClassMethodBinder), so a Storage.prototype spy never fires here;
 * spying on the instance is the same contract (the write itself throws). */
function failStorageWrites() {
	return vi.spyOn(localStorage, "setItem").mockImplementation(() => {
		throw new Error("quota");
	});
}

function seedRegistry(): void {
	localStorage.setItem("rc.hosts", JSON.stringify([TEST_HOST]));
}

/** Flushes pending connection and React work across several macrotasks. */
async function flush(): Promise<void> {
	for (let round = 0; round < 5; round++) {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		});
	}
}

function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
	const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	setter?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(element: Element | null): Promise<void> {
	expect(element).not.toBeNull();
	await act(async () => {
		(element as HTMLButtonElement).click();
	});
}

function postBodies(records: RecordedFetch[]): Array<{ url: string; body: unknown; headers: Record<string, string> }> {
	return records.map((record) => ({
		url: record.url,
		body: JSON.parse(typeof record.init?.body === "string" ? record.init.body : "{}"),
		headers: (record.init?.headers ?? {}) as Record<string, string>,
	}));
}

describe("connection: SSE frame parser", () => {
	it("parses complete frames from one chunk", () => {
		const parser = new SseFrameParser();
		const frames = parser.push('id: 0\nevent: snapshot\ndata: {"a":1}\n\n');
		expect(frames).toEqual([{ id: "0", event: "snapshot", data: '{"a":1}' }]);
	});

	it("buffers a frame split across chunks", () => {
		const parser = new SseFrameParser();
		expect(parser.push("id: 4\nevent: mess")).toEqual([]);
		expect(parser.push("age_delta\ndata: {\"x\":")).toEqual([]);
		expect(parser.push("true}\n")).toEqual([]);
		expect(parser.push("\n")).toEqual([{ id: "4", event: "message_delta", data: '{"x":true}' }]);
	});

	it("ignores comment lines such as heartbeats", () => {
		const parser = new SseFrameParser();
		const frames = parser.push(": heartbeat\ndata: x\n\n");
		expect(frames).toEqual([{ data: "x" }]);
	});

	it("joins multi-line data with newline", () => {
		const parser = new SseFrameParser();
		const frames = parser.push("data: one\ndata: two\n\n");
		expect(frames).toEqual([{ data: "one\ntwo" }]);
	});

	it("dispatches a trailing frame at flush without a final newline", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data: tail")).toEqual([]);
		expect(parser.flush()).toEqual([{ data: "tail" }]);
	});

	it("treats CR, LF, and CRLF as line breaks, including a CRLF split across chunks", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data: a\r")).toEqual([]);
		expect(parser.push("\ndata: b\r\n\r\n")).toEqual([{ data: "a\nb" }]);
		expect(parser.push("data: c\r\r")).toEqual([]);
		expect(parser.flush()).toEqual([{ data: "c" }]);
	});

	it("consumes a real fixture split into 7-byte chunks end to end", async () => {
		const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "hummin-mid.events.json"), "utf8")) as AnyRemoteEvent[];
		const bytes = new TextEncoder().encode(sseText(fixture));
		const chunks: Uint8Array[] = [];
		for (let offset = 0; offset < bytes.length; offset += 7) chunks.push(bytes.subarray(offset, offset + 7));
		const frames: SseFrame[] = [];
		await consumeStream(streamOf(chunks), (frame) => frames.push(frame));
		expect(frames).toHaveLength(fixture.length);
		const parsed = frames.map(parseProtocolEvent);
		expect(parsed.every((event) => event !== null)).toBe(true);
		expect(parsed[0]?.type).toBe("snapshot");
		expect(parsed.at(-1)?.seq).toBe(fixture.at(-1)?.seq);
	});

	it("drops malformed protocol payloads at the trust boundary", () => {
		expect(parseProtocolEvent({ data: "not json" })).toBeNull();
		expect(parseProtocolEvent({ data: "[]" })).toBeNull();
		expect(parseProtocolEvent({ data: JSON.stringify({ v: 2, seq: 0, ts: TS, type: "ping", payload: {} }) })).toBeNull();
		expect(parseProtocolEvent({ data: JSON.stringify({ v: 1, seq: 0.5, ts: TS, type: "ping", payload: {} }) })).toBeNull();
		expect(parseProtocolEvent({ data: JSON.stringify({ v: 1, seq: 0, ts: TS, type: "other", payload: {} }) })).toBeNull();
		expect(parseProtocolEvent({ data: JSON.stringify({ v: 1, seq: 0, ts: TS, type: "ping" }) })).toBeNull();
		expect(parseProtocolEvent({ data: JSON.stringify({ v: 1, seq: 7, ts: TS, type: "ping", payload: {} }) })).not.toBeNull();
	});
});

describe("connection: reconnect state machine", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function open(options: Partial<Parameters<typeof connectSse>[0]>): { connection: SseConnection; states: ConnectionState[] } {
		const states: ConnectionState[] = [];
		const connection = connectSse({
			origin: "http://127.0.0.1:9",
			token: "secret",
			onFrame: () => undefined,
			onState: (state) => states.push(state),
			...options,
		});
		return { connection, states };
	}

	it("connects, dispatches frames, and tracks the last id", async () => {
		vi.useFakeTimers();
		const frames: SseFrame[] = [];
		const records: RecordedFetch[] = [];
		const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
			records.push({ url: url.toString(), init });
			return Promise.resolve(fakeResponse({ ok: true, status: 200, body: liveStreamOf([new TextEncoder().encode("id: 3\ndata: {}\n\n")]) }));
		};
		const { connection, states } = open({ fetchImpl: fetchImpl as unknown as typeof fetch, onFrame: (frame) => frames.push(frame) });
		expect(states[0]).toBe("connecting");
		await vi.advanceTimersByTimeAsync(0);
		expect(states).toEqual(["connecting", "connected"]);
		expect(frames).toEqual([{ id: "3", data: "{}" }]);
		expect(connection.getLastId()).toBe("3");
		expect(records[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" });
		expect("last-event-id" in (records[0]?.init?.headers ?? {})).toBe(false);
		connection.close();
		expect(states.at(-1)).toBe("closed");
	});

	it("stops on 401 without hot-reconnecting", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(() => Promise.resolve(fakeResponse({ status: 401 })));
		const { states } = open({ fetchImpl: fetchMock as unknown as typeof fetch });
		await vi.advanceTimersByTimeAsync(0);
		expect(states).toEqual(["connecting", "unauthorized"]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("backs off exponentially on unreachable hosts, capped at 8s", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(() => Promise.reject(new TypeError("connection refused")));
		const { states } = open({ fetchImpl: fetchMock as unknown as typeof fetch });
		await vi.advanceTimersByTimeAsync(0);
		expect(states).toEqual(["connecting", "unreachable"]);
		// delays: 250, 500, 1000, 2000, 4000, then 8000 forever
		await vi.advanceTimersByTimeAsync(250);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(499);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(4000);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		await vi.advanceTimersByTimeAsync(8000);
		expect(fetchMock).toHaveBeenCalledTimes(7);
		const reconnectStates = states.filter((state) => state === "reconnecting");
		expect(reconnectStates.length).toBeGreaterThanOrEqual(5);
	});

	it("resets the backoff after a successful connection and replays from Last-Event-ID", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const records: RecordedFetch[] = [];
		const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
			records.push({ url: url.toString(), init });
			attempts++;
			if (attempts === 1) {
				return Promise.reject(new TypeError("down"));
			}
			// Second attempt: a real frame with an id, then the stream ends.
			const bytes = new TextEncoder().encode("id: 41\nevent: ping\ndata: {}\n\n");
			return Promise.resolve(fakeResponse({ ok: true, status: 200, body: streamOf([bytes]) }));
		};
		const { states } = open({ fetchImpl: fetchImpl as unknown as typeof fetch });
		await vi.advanceTimersByTimeAsync(0);
		expect(states).toEqual(["connecting", "unreachable"]);
		await vi.advanceTimersByTimeAsync(250);
		expect(states).toEqual(["connecting", "unreachable", "reconnecting", "connected", "reconnecting"]);
		expect(records[1]?.init?.headers).not.toHaveProperty("last-event-id");
		// Backoff was reset by the success: the next retry waits only 250ms.
		await vi.advanceTimersByTimeAsync(250);
		expect(records[2]?.init?.headers).toMatchObject({ "last-event-id": "41" });
	});

	it("close() stops in-flight attempts and pending retries", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(() => Promise.reject(new TypeError("down")));
		const { connection, states } = open({ fetchImpl: fetchMock as unknown as typeof fetch });
		await vi.advanceTimersByTimeAsync(0);
		connection.close();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(states.at(-1)).toBe("closed");
	});

	it("posts actions with the bearer header and reports non-ok results", async () => {
		const posts: RecordedFetch[] = [];
		const fetchImpl = consoleFetch([], posts);
		const result = await postApproval({ origin: "http://127.0.0.1:9/", token: "secret", id: "a1", allow: true, fetchImpl });
		expect(result).toEqual({ ok: true, status: 202 });
		const posted = postBodies(posts)[0];
		expect(posted?.url).toBe("http://127.0.0.1:9/approval");
		expect(posted?.body).toEqual({ id: "a1", allow: true });
		expect(posted?.headers).toMatchObject({ authorization: "Bearer secret", "content-type": "application/json" });
	});

	it("registers a console origin on a host with a fresh id", async () => {
		const posts: RecordedFetch[] = [];
		const fetchImpl = consoleFetch([], posts);
		const result = await postConsoleOrigin({ origin: "http://127.0.0.1:9", token: "host-token", consoleOrigin: "https://console.example:5173", fetchImpl });
		expect(result).toEqual({ ok: true, status: 202 });
		const posted = postBodies(posts)[0];
		expect(posted?.url).toBe("http://127.0.0.1:9/settings/console-origins");
		expect(posted?.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), origin: "https://console.example:5173" });
		expect(posted?.headers).toMatchObject({ authorization: "Bearer host-token" });
	});
});

describe("store: per-host reducer", () => {
	const SNAPSHOT: SnapshotPayload = {
		host: { origin: "http://127.0.0.1:9", label: "main" },
		protocolVersion: 1,
		sessionId: "s1",
		sessionName: "session one",
		status: { kind: "idle", model: { provider: "acme", modelId: "big-1" }, thinkingLevel: "high", contextUsage: { tokens: 100, contextWindow: 200, percent: 50 } },
		messages: [{ entryId: "e0", message: { role: "user", blocks: [{ type: "text", text: "hello doc" }] } }],
		holds: [],
		queue: { items: [{ id: "q1", preview: "queued text", deliverAs: "steer" }], terminalQueued: 2 },
	};

	function ensured(): HostStore {
		return reduceHosts({}, { type: "ensure", hostId: "h1", label: "lab", origin: "http://127.0.0.1:9" });
	}

	function dispatch(store: HostStore, event: AnyRemoteEvent, receivedAt = 1000): HostStore {
		return reduceHosts(store, { type: "event", hostId: "h1", event, receivedAt });
	}

	it("keeps the last tok/s across a null status and clears it on a new session", () => {
		const withRate = (rate: number | null): WireStatus => ({ kind: "idle", model: null, stats: { tokensPerSecond: rate } });
		let store = dispatch(ensured(), makeEvent("snapshot", 1, SNAPSHOT));
		store = dispatch(store, makeEvent("status", 2, { status: withRate(42.5) }));
		expect(store.h1?.lastTokensPerSecond).toBe(42.5);
		store = dispatch(store, makeEvent("status", 3, { status: withRate(null) }));
		expect(store.h1?.lastTokensPerSecond).toBe(42.5);
		store = dispatch(store, makeEvent("snapshot", 4, { ...SNAPSHOT, status: withRate(null) }));
		expect(store.h1?.lastTokensPerSecond).toBe(42.5);
		store = dispatch(store, makeEvent("snapshot", 5, { ...SNAPSHOT, sessionId: "s2", status: withRate(null) }));
		expect(store.h1?.lastTokensPerSecond).toBeNull();
	});

	it("starts a host from ensure with the registry identity", () => {
		const store = ensured();
		const state = store.h1;
		expect(state?.label).toBe("lab");
		expect(state?.origin).toBe("http://127.0.0.1:9");
		expect(state?.connection).toBe("connecting");
		expect(state?.entries).toEqual([]);
		expect(state?.toolUpdates.size).toBe(0);
	});

	it("ensure refreshes the identity and unknown-host events are dropped", () => {
		const renamed = reduceHosts(ensured(), { type: "ensure", hostId: "h1", label: "renamed", origin: "http://127.0.0.1:9" });
		expect(renamed.h1?.label).toBe("renamed");
		const dropped = reduceHosts({}, { type: "event", hostId: "ghost", event: makeEvent("ping", 0, {}), receivedAt: 1 });
		expect(dropped.ghost).toBeUndefined();
	});

	it("snapshot replaces the slices and anchors seq and lastSeen", () => {
		const state = dispatch(ensured(), makeEvent("snapshot", 5, SNAPSHOT), 1234).h1;
		expect(state?.sessionId).toBe("s1");
		expect(state?.sessionName).toBe("session one");
		expect(state?.status?.kind).toBe("idle");
		expect(state?.status?.model).toEqual({ provider: "acme", modelId: "big-1" });
		expect(state?.entries).toHaveLength(1);
		expect(state?.entries[0]?.entryId).toBe("e0");
		expect(state?.holds).toEqual([]);
		expect(state?.queue?.items).toHaveLength(1);
		expect(state?.lastSeq).toBe(5);
		expect(state?.lastSeenMs).toBe(1234);
		expect(state?.slot).toBeNull();
	});

	it("message_start, deltas, and message_end fold the slot into an entry", () => {
		let store = dispatch(ensured(), makeEvent("message_start", 1, { slotKey: "k1", message: { role: "assistant", blocks: [{ type: "text", text: "" }] } }));
		let state = store.h1;
		expect(state?.slot?.frozen).toBe(false);
		store = dispatch(store, makeEvent("message_delta", 2, { slotKey: "k1", event: { type: "text_delta", contentIndex: 0, delta: "hi " } }));
		store = dispatch(store, makeEvent("message_delta", 3, { slotKey: "k1", event: { type: "text_delta", contentIndex: 0, delta: "there" } }));
		state = store.h1;
		expect(state?.slot?.blocks[0]).toEqual({ type: "text", text: "hi there" });
		store = dispatch(store, makeEvent("message_end", 4, { slotKey: "k1", entryId: "e1", message: { role: "assistant", blocks: [{ type: "text", text: "hi there" }] } }));
		state = store.h1;
		expect(state?.slot).toBeNull();
		expect(state?.entries.map((entry) => entry.entryId)).toEqual(["e1"]);
		expect(state?.entries[0]?.message.blocks).toEqual([{ type: "text", text: "hi there" }]);
		expect(state?.entries[0]?.timestamp).toBe(TS);
		expect(state?.lastSeq).toBe(4);
	});

	it("a delta without a start opens an implicit slot (replay tolerance)", () => {
		const store = dispatch(ensured(), makeEvent("message_delta", 1, { slotKey: "k2", event: { type: "text_delta", contentIndex: 0, delta: "implicit" } }));
		const state = store.h1;
		expect(state?.slot?.slotKey).toBe("k2");
		expect(state?.slot?.role).toBe("assistant");
		expect(state?.slot?.blocks[0]).toEqual({ type: "text", text: "implicit" });
	});

	it("message_end without a slot still lands the entry", () => {
		const store = dispatch(ensured(), makeEvent("message_end", 1, { slotKey: "k3", entryId: "e9", message: { role: "assistant", blocks: [{ type: "text", text: "done" }] } }));
		const state = store.h1;
		expect(state?.entries).toHaveLength(1);
		expect(state?.entries[0]?.entryId).toBe("e9");
		expect(state?.slot).toBeNull();
	});

	it("a duplicate message_end is deduped by entryId", () => {
		let store = dispatch(ensured(), makeEvent("message_start", 1, { slotKey: "k1", message: { role: "assistant", blocks: [] } }));
		store = dispatch(store, makeEvent("message_end", 2, { slotKey: "k1", entryId: "e1", message: { role: "assistant", blocks: [{ type: "text", text: "once" }] } }));
		store = dispatch(store, makeEvent("message_end", 3, { slotKey: "k1", entryId: "e1", message: { role: "assistant", blocks: [{ type: "text", text: "twice" }] } }));
		const state = store.h1;
		expect(state?.entries).toHaveLength(1);
		expect(state?.entries[0]?.message.blocks).toEqual([{ type: "text", text: "once" }]);
		expect(state?.slot).toBeNull();
	});

	it("an empty entryId never dedupes: every such end appends its entry", () => {
		let store = dispatch(ensured(), makeEvent("message_end", 1, { slotKey: "k1", entryId: "", message: { role: "assistant", blocks: [{ type: "text", text: "first" }] } }));
		store = dispatch(store, makeEvent("message_end", 2, { slotKey: "k2", entryId: "", message: { role: "assistant", blocks: [{ type: "text", text: "second" }] } }));
		const state = store.h1;
		expect(state?.entries.map((entry) => entry.entryId)).toEqual(["", ""]);
		expect(state?.entries[0]?.message.blocks).toEqual([{ type: "text", text: "first" }]);
		expect(state?.entries[1]?.message.blocks).toEqual([{ type: "text", text: "second" }]);
	});

	it("tool_update patches the live map by toolCallId; unknown ids change no transcript", () => {
		let store = dispatch(ensured(), makeEvent("snapshot", 0, SNAPSHOT));
		store = dispatch(store, makeEvent("tool_update", 1, { toolCallId: "t1", phase: "start", toolName: "bash" }));
		store = dispatch(store, makeEvent("tool_update", 2, { toolCallId: "t1", phase: "update", toolName: "bash", partialResult: "working" }));
		store = dispatch(store, makeEvent("tool_update", 3, { toolCallId: "t1", phase: "end", toolName: "bash", isError: true, durationMs: 1500 }));
		let state = store.h1;
		// Each tool_update replaces the live phase for its toolCallId; the card
		// renders the newest one.
		expect(state?.toolUpdates.get("t1")).toEqual({ phase: "end", isError: true, durationMs: 1500 });
		const before = state?.entries.length;
		store = dispatch(store, makeEvent("tool_update", 4, { toolCallId: "ghost", phase: "start", toolName: "read" }));
		state = store.h1;
		expect(state?.entries.length).toBe(before);
		expect(state?.toolUpdates.get("ghost")).toEqual({ phase: "start" });
	});

	it("status, queue, session, and holds events replace their slices", () => {
		let store = dispatch(ensured(), makeEvent("snapshot", 0, SNAPSHOT));
		store = dispatch(store, makeEvent("status", 1, { status: { kind: "working", model: { provider: "acme", modelId: "big-1" }, contextUsage: { tokens: null, contextWindow: 200, percent: 12 } } }));
		expect(store.h1?.status?.kind).toBe("working");
		expect(store.h1?.status?.thinkingLevel).toBeUndefined();
		store = dispatch(store, makeEvent("queue", 2, { queue: { items: [], terminalQueued: 1 } }));
		expect(store.h1?.queue).toEqual({ items: [], terminalQueued: 1 });
		store = dispatch(store, makeEvent("session", 3, { sessionId: "s2", sessionName: "renamed" }));
		expect(store.h1?.sessionId).toBe("s2");
		expect(store.h1?.sessionName).toBe("renamed");
		const first: WireApproval = { id: "a1", toolName: "edit", argsPreview: "/tmp/x", deadlineMs: 9999, createdAt: TS };
		const second: WireApproval = { id: "a2", toolName: "bash", argsPreview: "ls", deadlineMs: 10_000, createdAt: TS };
		store = dispatch(store, makeEvent("approval", 4, { holds: [first, second] }));
		expect(store.h1?.holds).toEqual([first, second]);
		// approval_done removes by id and leaves the other holds alone.
		store = dispatch(store, makeEvent("approval_done", 5, { id: "other", resolution: "expired" }));
		expect(store.h1?.holds).toEqual([first, second]);
		store = dispatch(store, makeEvent("approval_done", 6, { id: "a1", resolution: "denied" }));
		expect(store.h1?.holds).toEqual([second]);
		// A fresh full list replaces the slice wholesale.
		store = dispatch(store, makeEvent("approval", 7, { holds: [second] }));
		expect(store.h1?.holds).toEqual([second]);
	});

	it("ping touches only lastSeen and lastSeq", () => {
		let store = dispatch(ensured(), makeEvent("snapshot", 0, SNAPSHOT));
		const before = store.h1;
		store = dispatch(store, makeEvent("ping", 9, {}), 5555);
		const state = store.h1;
		expect(state?.lastSeq).toBe(9);
		expect(state?.lastSeenMs).toBe(5555);
		expect(state?.entries).toEqual(before?.entries);
		expect(state?.status).toEqual(before?.status);
	});

	it("connection states ride the same reducer", () => {
		let store = reduceHosts(ensured(), { type: "connection", hostId: "h1", state: "connected" });
		expect(store.h1?.connection).toBe("connected");
		store = reduceHosts(store, { type: "connection", hostId: "h1", state: "unauthorized" });
		expect(store.h1?.connection).toBe("unauthorized");
		expect(initialHostState("x", "http://x").connection).toBe("connecting");
	});
});

describe("hosts: registry and appearance", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("round-trips hosts through localStorage with origin normalization", () => {
		const added = addHost({ label: "main", origin: "http://127.0.0.1:7777/", token: " tok " });
		expect(added).toMatchObject({ label: "main", origin: "http://127.0.0.1:7777", token: "tok" });
		expect(listHosts()).toHaveLength(1);
		updateHost(added.id, { label: "renamed", token: "tok2" });
		const hosts = listHosts();
		expect(hosts[0]).toMatchObject({ label: "renamed", token: "tok2", origin: "http://127.0.0.1:7777" });
		expect(hosts[0]?.id).toBe(added.id);
		removeHost(added.id);
		expect(listHosts()).toEqual([]);
	});

	it("falls back to the origin host as the label and rejects duplicates and empties", () => {
		const added = addHost({ label: "", origin: "http://10.0.0.7:1234", token: "t" });
		expect(added.label).toBe("10.0.0.7:1234");
		expect(() => addHost({ label: "x", origin: "http://10.0.0.7:1234/", token: "t" })).toThrow("already exists");
		expect(() => addHost({ label: "x", origin: "", token: "t" })).toThrow("origin is required");
		expect(() => addHost({ label: "x", origin: "http://10.0.0.9", token: " " })).toThrow("token is required");
	});

	it("tolerates corrupt or malformed storage", () => {
		expect(parseHosts(null)).toEqual([]);
		expect(parseHosts("not json")).toEqual([]);
		expect(parseHosts("{}")).toEqual([]);
		expect(parseHosts(JSON.stringify([{ id: "x", origin: "", token: "t" }, { id: "y", origin: "http://a:1", token: "t" }]))).toHaveLength(1);
	});

	it("appearance parses, persists, and applies to the document root", () => {
		expect(parseAppearance(null)).toEqual({ preset: "studio", accentHue: 190, motion: "auto" });
		expect(parseAppearance("garbage")).toEqual({ preset: "studio", accentHue: 190, motion: "auto" });
		expect(parseAppearance(JSON.stringify({ preset: "terminal", accentHue: 400, density: 9 }))).toEqual({ preset: "terminal", accentHue: 190, motion: "auto" });
		// Records saved before the motion axis existed parse as "auto"; an unknown
		// motion value falls back the same way.
		expect(parseAppearance(JSON.stringify({ preset: "paper", accentHue: 200, density: 1.5 }))).toEqual({ preset: "paper", accentHue: 200, motion: "auto" });
		expect(parseAppearance(JSON.stringify({ motion: "off" }))).toEqual({ preset: "studio", accentHue: 190, motion: "off" });
		expect(parseAppearance(JSON.stringify({ motion: "sometimes" }))).toMatchObject({ motion: "auto" });
		// Stored presets from before studio existed keep working; unknown ones fall back to studio.
		expect(parseAppearance(JSON.stringify({ preset: "glass" })).preset).toBe("glass");
		expect(parseAppearance(JSON.stringify({ preset: "studio" })).preset).toBe("studio");
		expect(parseAppearance(JSON.stringify({ preset: "neon" })).preset).toBe("studio");
		const appearance: Appearance = { preset: "paper", accentHue: 250, motion: "off" };
		saveAppearance(appearance);
		expect(loadAppearance()).toEqual(appearance);
		document.documentElement.style.setProperty("--rc-density", "0.85");
		applyAppearance(document.documentElement, appearance);
		expect(document.documentElement.dataset.rcPreset).toBe("paper");
		expect(document.documentElement.dataset.rcMotion).toBe("off");
		expect(document.documentElement.style.getPropertyValue("--rc-accent-hue")).toBe("250");
		// An inline density left by an older build is removed.
		expect(document.documentElement.style.getPropertyValue("--rc-density")).toBe("");
	});

	it("clamps the live axes onto their ranges", () => {
		expect(clampAccentHue(190)).toBe(190);
		expect(clampAccentHue(-20)).toBe(0);
		expect(clampAccentHue(400)).toBe(360);
		expect(clampAccentHue(250.6)).toBe(251);
		expect(clampAccentHue(Number.NaN)).toBe(190);
	});

	it("never turns an empty slider value into hue 0", () => {
		// Number("") is 0: the panel guards the raw string before clamping, so a
		// stray empty change event falls to the default instead of painting the
		// whole scene red (observed live).
		const empty = "";
		expect(clampAccentHue(empty === "" ? Number.NaN : Number(empty))).toBe(190);
	});
});

describe("hosts: fragment adoption", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	const fakeLocation = (origin: string, pathname = "/") =>
		({ origin, pathname, search: "" }) as unknown as Location;
	const fakeHistory = () => ({ replaceState: vi.fn() }) as unknown as History;

	it("enrolls the local host from a /remote-control fragment and strips the token from the URL", () => {
		const location = fakeLocation("http://127.0.0.1:59711");
		const history = fakeHistory();
		const entry = adoptLocalHost("#"+TOKEN_A, location, history);
		expect(entry).toMatchObject({ origin: "http://127.0.0.1:59711", token: TOKEN_A });
		// the registry stores the token (browser-side by design); the URL must not
		expect(history.replaceState).toHaveBeenCalledWith(null, "", location.pathname + location.search);
	});

	it("rotates the token for an existing origin entry instead of duplicating it", () => {
		const location = fakeLocation("http://127.0.0.1:59711");
		const history = fakeHistory();
		const first = adoptLocalHost("#"+TOKEN_A, location, history);
		const second = adoptLocalHost("#"+TOKEN_B, location, history);
		expect(second?.id).toBe(first?.id);
		expect(second?.token).toBe(TOKEN_B);
		expect(listHosts()).toHaveLength(1);
		expect(listHosts()[0]?.token).toBe(TOKEN_B);
	});

	it("returns null and touches nothing without a fragment token", () => {
		const location = fakeLocation("http://127.0.0.1:59711");
		const history = fakeHistory();
		expect(adoptLocalHost("", location, history)).toBeNull();
		expect(adoptLocalHost("#", location, history)).toBeNull();
		expect(history.replaceState).not.toHaveBeenCalled();
		expect(listHosts()).toEqual([]);
	});

	it("adopts the fragment and strips it even when storage writes throw (private mode)", () => {
		const setItem = failStorageWrites();
		try {
			const location = fakeLocation("http://127.0.0.1:59711");
			const history = fakeHistory();
			const entry = adoptLocalHost("#"+TOKEN_A, location, history);
			expect(entry).toMatchObject({ origin: "http://127.0.0.1:59711", token: TOKEN_A });
			// The fragment is stripped regardless of the storage failure.
			expect(history.replaceState).toHaveBeenCalledWith(null, "", location.pathname + location.search);
			// Nothing persisted, nothing thrown.
			expect(listHosts()).toEqual([]);
		} finally {
			setItem.mockRestore();
		}
	});
});

describe("components: rail status and approval countdown", () => {
	it("derives the rail status including staleness after 30s", () => {
		const base = initialHostState("lab", "http://x");
		const now = 100_000;
		const connected: typeof base = { ...base, connection: "connected", lastSeenMs: now - 1000 };
		expect(railStatus(connected, now)).toBe("connected");
		const stale: typeof base = { ...base, connection: "connected", lastSeenMs: now - 31_000 };
		expect(railStatus(stale, now)).toBe("stale");
		const connecting: typeof base = { ...base, connection: "connecting", lastSeenMs: null };
		expect(railStatus(connecting, now)).toBe("connecting");
		const unauthorized: typeof base = { ...base, connection: "unauthorized", lastSeenMs: null };
		expect(railStatus(unauthorized, now)).toBe("unauthorized");
		const unreachable: typeof base = { ...base, connection: "unreachable", lastSeenMs: now - 31_000 };
		expect(railStatus(unreachable, now)).toBe("unreachable");
		expect(railStatus(undefined, now)).toBe("offline");
	});

	it("counts down to the approval deadline without going negative", () => {
		const approval: WireApproval = { id: "a1", toolName: "bash", argsPreview: "ls", deadlineMs: 100_000, createdAt: TS };
		expect(countdownSeconds(approval, 90_000)).toBe(10);
		expect(countdownSeconds(approval, 100_001)).toBe(0);
	});

	it("renders one card per hold, each with its own countdown and resolution buttons", async () => {
		const holds: WireApproval[] = [
			{ id: "a1", toolName: "bash", argsPreview: "one", deadlineMs: Date.now() + 100_000, createdAt: TS },
			{ id: "a2", toolName: "edit", argsPreview: "two", deadlineMs: Date.now() + 200_000, createdAt: TS },
		];
		const resolved: Array<[string, boolean]> = [];
		const mounted = await mount(
			<ApprovalCard holds={holds} onResolve={(id, allow) => {
					resolved.push([id, allow]);
					return Promise.resolve({ ok: true, status: 202 });
				}} />,
		);
		try {
			await flush();
			const cards = document.querySelectorAll("[data-rc-approval]");
			expect(cards).toHaveLength(2);
			expect(cards[0]?.getAttribute("data-rc-approval-tool")).toBe("bash");
			expect(cards[1]?.getAttribute("data-rc-approval-tool")).toBe("edit");
			// The honest expiry terms: a deadline hit proceeds with the call.
			const hints = document.querySelectorAll(".rc-approval-hint");
			expect(hints).toHaveLength(2);
			expect(hints[0]?.textContent).toContain("expiry proceeds with the call");
			await click(document.querySelector('[data-rc-approve="a2"]'));
			await click(document.querySelector('[data-rc-deny="a1"]'));
			expect(resolved).toEqual([
				["a2", true],
				["a1", false],
			]);
		} finally {
			await mounted.unmount();
		}
	});

	it("shows the token-rotation recovery hint on an unauthorized row", async () => {
		const hosts = [{ id: "h1", label: "main", origin: "http://127.0.0.1:9", token: "secret" }];
		const state = { ...initialHostState("main", "http://127.0.0.1:9"), connection: "unauthorized" as ConnectionState };
		const mounted = await mount(
			<HostRail
				hosts={hosts}
				states={{ h1: state }}
				activeId="h1"
				originWarnings={{}}
				onSelect={() => undefined}
				onAdd={() => undefined}
				onRemove={() => undefined}
			/>,
		);
		try {
			await flush();
			const hint = document.querySelector("[data-rc-auth-hint]");
			expect(hint?.textContent).toContain("token rotated - run /remote-control and reopen its URL, or remove and re-add this host");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("app: appearance panel", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function openPanel(): Promise<Mounted> {
		seedRegistry();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<App />);
		await flush();
		await click(document.querySelector("[data-rc-appearance-open]"));
		await flush();
		return mounted;
	}

	it("opens from the header as a labelled dialog with the live preview", async () => {
		const mounted = await openPanel();
		try {
			const panel = document.querySelector("[data-rc-appear-panel]");
			expect(panel).not.toBeNull();
			expect(panel?.getAttribute("role")).toBe("dialog");
			expect(panel?.getAttribute("aria-modal")).toBe("true");
			expect(panel?.getAttribute("aria-label")).toBe("appearance");
			expect(document.querySelector("[data-rc-appear-preview]")).not.toBeNull();
			for (const preset of ["studio", "glass", "paper", "terminal"]) {
				const swatch = document.querySelector(`[data-rc-appear-swatch="${preset}"]`);
				expect(swatch).not.toBeNull();
				// Each swatch re-resolves its own preset's tokens.
				expect(swatch?.getAttribute("data-rc-preset")).toBe(preset);
			}
			expect(document.querySelector('[data-rc-appear-swatch="studio"]')?.getAttribute("aria-pressed")).toBe("true");
			expect(document.querySelector("[data-rc-appear-hue]")).not.toBeNull();
			expect(document.querySelector("[data-rc-appear-density]")).toBeNull();
			expect(document.querySelector('[data-rc-appear-motion="auto"]')).not.toBeNull();
			// Opening moves focus into the dialog.
			expect(document.activeElement?.getAttribute("data-rc-appear-panel")).toBe("true");
		} finally {
			await mounted.unmount();
		}
	});

	it("closes on Escape and hands focus back to the opener", async () => {
		seedRegistry();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<App />);
		try {
			await flush();
			// A real click focuses the button; model that so the opener is captured.
			const opener = document.querySelector<HTMLButtonElement>("[data-rc-appearance-open]");
			await act(async () => {
				opener?.focus();
			});
			await click(opener);
			await flush();
			expect(document.querySelector("[data-rc-appear-panel]")).not.toBeNull();
			await act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			});
			await flush();
			expect(document.querySelector("[data-rc-appear-panel]")).toBeNull();
			expect(document.activeElement).toBe(opener);
		} finally {
			await mounted.unmount();
		}
	});

	it("closes on a scrim click", async () => {
		const mounted = await openPanel();
		try {
			await click(document.querySelector("[data-rc-appear-scrim]"));
			await flush();
			expect(document.querySelector("[data-rc-appear-panel]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("traps Tab inside the panel, skipping decorative stops", async () => {
		const mounted = await openPanel();
		try {
			const stops = Array.from(document.querySelectorAll<HTMLElement>("[data-rc-appear-panel] button, [data-rc-appear-panel] input")).filter(
				(node) => !node.hasAttribute("disabled") && node.getAttribute("tabindex") !== "-1",
			);
			expect(stops.length).toBeGreaterThan(1);
			const last = stops[stops.length - 1];
			await act(async () => {
				last?.focus();
			});
			await act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
			});
			expect(document.activeElement).toBe(stops[0]);
			await act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
			});
			expect(document.activeElement).toBe(last);
		} finally {
			await mounted.unmount();
		}
	});

	it("applies preset, hue, and motion live and persists them", async () => {
		const mounted = await openPanel();
		try {
			// Preset swatch switches the root preset and persists.
			await click(document.querySelector('[data-rc-appear-swatch="paper"]'));
			expect(document.documentElement.dataset.rcPreset).toBe("paper");
			// Sliders apply their clamped axes to the root custom properties.
			const hue = document.querySelector<HTMLInputElement>("[data-rc-appear-hue]");
			await act(async () => {
				setNativeValue(hue as HTMLInputElement, "250");
			});
			expect(document.documentElement.style.getPropertyValue("--rc-accent-hue")).toBe("250");
			// Motion off applies the root attribute.
			await click(document.querySelector('[data-rc-appear-motion="off"]'));
			expect(document.documentElement.dataset.rcMotion).toBe("off");
			// Everything persisted in the same tick.
			const saved = JSON.parse(localStorage.getItem("rc.appearance") ?? "{}") as { preset?: string; accentHue?: number; motion?: string };
			expect(saved).toEqual({ preset: "paper", accentHue: 250, motion: "off" });
			// The panel's readouts track the applied values.
			expect(document.querySelector("[data-rc-appear-hue-value]")?.getAttribute("data-rc-appear-hue-value")).toBe("250");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("app: shell integration", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders the three regions and rail rows before any connection resolves", async () => {
		seedRegistry();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<App />);
		try {
			await flush();
			expect(document.querySelectorAll("[data-rc-region]").length).toBe(3);
			for (const region of ["header", "transcript", "composer"] as const) {
				expect(document.querySelector(`[data-rc-region="${region}"]`)).not.toBeNull();
			}
			const row = document.querySelector('[data-rc-host-row="h1"]');
			expect(row).not.toBeNull();
			expect(row?.getAttribute("data-rc-host-status")).toBe("connecting");
			// One indicator marks the active row; the header names the host and its state.
			expect(row?.getAttribute("data-rc-active")).toBe("true");
			expect(document.querySelectorAll("[data-rc-rail-indicator]")).toHaveLength(1);
			expect(document.querySelector("[data-rc-status-dot]")?.getAttribute("data-rc-status-dot")).toBe("connecting");
			expect(document.querySelector(".rc-header-title")?.textContent).not.toBe("");
			// The token is sent only as the Authorization header, never in a URL.
			expect(records.length).toBeGreaterThanOrEqual(1);
			expect(records[0]?.url).toBe("http://127.0.0.1:9/events");
			expect(records[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" });
			expect(records.every((record) => !record.url.includes("secret"))).toBe(true);
		} finally {
			await mounted.unmount();
		}
	});

	it("folds a live stream into the transcript, header, queue, and composer", async () => {
		seedRegistry();
		const snapshot: SnapshotPayload = {
			host: { origin: TEST_HOST.origin, label: "main" },
			protocolVersion: 1,
			sessionId: "s1",
			sessionName: "session one",
			status: { kind: "working", model: { provider: "acme", modelId: "big-1" }, thinkingLevel: "high", contextUsage: { tokens: 84, contextWindow: 200, percent: 42 } },
			messages: [{ entryId: "e0", message: { role: "user", blocks: [{ type: "text", text: "hello doc" }] } }],
			holds: [],
			queue: { items: [{ id: "q1", preview: "queued text", deliverAs: "steer" }], terminalQueued: 2 },
		};
		const approvalEvent = makeEvent("approval", 1, { holds: [{ id: "a1", toolName: "bash", argsPreview: "rm -rf /tmp/scratch", deadlineMs: Date.now() + 120_000, createdAt: TS }] });
		const queueEvent = makeEvent("queue", 2, { queue: { items: [{ id: "q2", preview: "later please", deliverAs: "followUp" }], terminalQueued: 0 } });
		const events: AnyRemoteEvent[] = [makeEvent("snapshot", 0, snapshot), approvalEvent, queueEvent];
		const posts: RecordedFetch[] = [];
		vi.stubGlobal("fetch", consoleFetch(events, posts));
		const mounted = await mount(<App />);
		try {
			await flush();
			expect(document.querySelector('[data-rc-host-row="h1"]')?.getAttribute("data-rc-host-status")).toBe("connected");
			expect(document.querySelector('[data-entry-id="e0"]')).not.toBeNull();
			expect(document.querySelector("[data-rc-model]")?.textContent).toBe("acme/big-1");
			expect(document.querySelector("[data-rc-thinking]")?.textContent).toContain("high");
			expect(document.querySelector("[data-rc-ctx]")?.getAttribute("data-rc-ctx")).toBe("42");
			// The queue event (seq 2) replaced the snapshot's queue slice.
			expect(document.querySelector('[data-rc-queue-item="q2"] [data-rc-queue-deliver]')?.getAttribute("data-rc-queue-deliver")).toBe("followUp");
			expect(document.querySelector('[data-rc-queue-item="q2"]')?.textContent).toContain("later please");
			expect(document.querySelector("[data-rc-queue-terminal]")).toBeNull();

			// Approval flow: the card appears for the pending hold and posts on click.
			const card = document.querySelector("[data-rc-approval]");
			expect(card?.getAttribute("data-rc-approval-tool")).toBe("bash");
			// The attention state is never color alone: the label chip names it.
			expect(document.querySelector("[data-rc-approval-label]")?.textContent).toBe("approval");
			// Expiry is honest: the card states the fail-open terms.
			expect(document.querySelector(".rc-approval-hint")?.textContent).toContain("expiry proceeds with the call");
			await click(document.querySelector('[data-rc-approve="a1"]'));
			const approvalPost = postBodies(posts).find((post) => post.url.endsWith("/approval"));
			expect(approvalPost?.body).toEqual({ id: "a1", allow: true });
			expect(approvalPost?.headers).toMatchObject({ authorization: "Bearer secret" });

			// Composer: default followUp delivery, prompt POST with a fresh id.
			const textarea = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]");
			expect(textarea?.getAttribute("maxlength")).toBe("12000");
			expect(document.querySelector("[data-rc-deliver-as]")?.getAttribute("data-rc-deliver-as")).toBe("followUp");
			await act(async () => {
				setNativeValue(textarea as HTMLTextAreaElement, "hello agent");
			});
			await click(document.querySelector("[data-rc-send]"));
			const promptPost = postBodies(posts).find((post) => post.url.endsWith("/prompt"));
			expect(promptPost?.body).toMatchObject({ text: "hello agent", deliverAs: "followUp" });
			expect((promptPost?.body as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
			expect(textarea?.value).toBe("");

			// Abort posts too.
			await click(document.querySelector("[data-rc-abort]"));
			expect(posts.some((post) => post.url.endsWith("/abort"))).toBe(true);
		} finally {
			await mounted.unmount();
		}
	});

	it("switches presets through the header and persists the appearance", async () => {
		seedRegistry();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<App />);
		try {
			await flush();
			expect(document.documentElement.dataset.rcPreset).toBe("studio");
			await click(document.querySelector('[data-rc-preset-btn="paper"]'));
			expect(document.documentElement.dataset.rcPreset).toBe("paper");
			const saved = JSON.parse(localStorage.getItem("rc.appearance") ?? "{}") as { preset?: string };
			expect(saved.preset).toBe("paper");
			await click(document.querySelector('[data-rc-preset-btn="terminal"]'));
			expect(document.documentElement.dataset.rcPreset).toBe("terminal");
		} finally {
			await mounted.unmount();
		}
	});

	it("applies persisted appearance axes to the document root on mount", async () => {
		seedRegistry();
		localStorage.setItem("rc.appearance", JSON.stringify({ preset: "terminal", accentHue: 250, density: 0.85 }));
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<App />);
		try {
			await flush();
			expect(document.documentElement.dataset.rcPreset).toBe("terminal");
			expect(document.documentElement.style.getPropertyValue("--rc-accent-hue")).toBe("250");
			expect(document.documentElement.style.getPropertyValue("--rc-density")).toBe("");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders the approval cards hidden when no hold is pending", async () => {
		localStorage.clear();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<ApprovalCard holds={[]} onResolve={() => Promise.resolve({ ok: true, status: 202 })} />);
		try {
			await flush();
			expect(document.querySelector("[data-rc-approval]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("shows the no-hosts onboarding card and registers a host through its inline form", async () => {
		localStorage.clear();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<App />);
		try {
			await flush();
			const onboarding = document.querySelector("[data-rc-empty]");
			expect(onboarding).not.toBeNull();
			expect(onboarding?.textContent).toContain("Add your first host");
			// The form leads while empty: expanded, inline in the onboarding card.
			const toggle = document.querySelector<HTMLButtonElement>("[data-rc-add-toggle]");
			expect(toggle?.getAttribute("aria-expanded")).toBe("true");
			expect(document.querySelector(".rc-add-fields")?.getAttribute("data-rc-add-open")).toBe("true");

			// Adding a host through the form lands the row and retires onboarding.
			await act(async () => {
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-origin]") as HTMLInputElement, "http://127.0.0.1:7777");
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-token]") as HTMLInputElement, "tok");
			});
			await click(document.querySelector("[data-rc-add-submit]"));
			await flush();
			expect(document.querySelector("[data-rc-empty]")).toBeNull();
			expect(localStorage.getItem("rc.hosts")).toContain("127.0.0.1:7777");
			const row = document.querySelector("[data-rc-host-row]");
			expect(row).not.toBeNull();

			// With hosts present the form collapses behind the toggle.
			const collapsed = document.querySelector<HTMLButtonElement>("[data-rc-add-toggle]");
			expect(collapsed?.getAttribute("aria-expanded")).toBe("true");
			await click(collapsed);
			await flush();
			expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
			// The Disclosure unmounts its fields synchronously when motion resolves to 0ms.
			expect(document.querySelector(".rc-add-fields")).toBeNull();
			expect(document.querySelector("[data-rc-add-origin]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("registers a cross-origin host's console origin and warns on the rail when that fails", async () => {
		localStorage.clear();
		const posts: RecordedFetch[] = [];
		let failRegistration = true;
		const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
			const urlText = url.toString();
			if (urlText.endsWith("/events")) {
				return Promise.resolve(fakeResponse({ ok: true, status: 200, body: liveStreamOf([new TextEncoder().encode("")]) }));
			}
			posts.push({ url: urlText, init });
			return Promise.resolve(fakeResponse({ ok: !failRegistration, status: failRegistration ? 403 : 202 }));
		};
		vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
		const mounted = await mount(<App />);
		try {
			await flush();

			// First host: cross-origin, and the registration POST fails.
			await act(async () => {
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-origin]") as HTMLInputElement, "http://127.0.0.1:7777");
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-token]") as HTMLInputElement, "tok");
			});
			await click(document.querySelector("[data-rc-add-submit]"));
			await flush();
			const registration = postBodies(posts).find((post) => post.url.endsWith("/settings/console-origins"));
			expect(registration).toBeDefined();
			expect(registration?.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), origin: window.location.origin });
			expect(registration?.headers).toMatchObject({ authorization: "Bearer tok" });
			const warning = document.querySelector("[data-rc-origin-warn]");
			expect(warning?.textContent).toContain("origins not registered - cross-origin may fail");
			expect(warning?.textContent).toContain("status 403");

			// Second host: the registration succeeds, so its row stays silent.
			failRegistration = false;
			await act(async () => {
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-origin]") as HTMLInputElement, "http://127.0.0.1:8888");
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-token]") as HTMLInputElement, "tok2");
			});
			await click(document.querySelector("[data-rc-add-submit]"));
			await flush();
			expect(posts.filter((post) => post.url.endsWith("/settings/console-origins"))).toHaveLength(2);
			expect(document.querySelectorAll("[data-rc-origin-warn]")).toHaveLength(1);

			// The page's own origin needs no registration.
			await act(async () => {
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-origin]") as HTMLInputElement, window.location.origin);
				setNativeValue(document.querySelector<HTMLInputElement>("[data-rc-add-token]") as HTMLInputElement, "tok3");
			});
			await click(document.querySelector("[data-rc-add-submit]"));
			await flush();
			expect(posts.filter((post) => post.url.endsWith("/settings/console-origins"))).toHaveLength(2);
		} finally {
			await mounted.unmount();
		}
	});

	it("renders the adopted host when storage writes fail (private mode)", async () => {
		localStorage.clear();
		const setItem = failStorageWrites();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		try {
			window.location.hash = "#"+TOKEN_A;
			const mounted = await mount(<App />);
			try {
				await flush();
				// The adopted entry is in memory even though nothing persisted.
				const row = document.querySelector("[data-rc-host-row]");
				expect(row).not.toBeNull();
				expect(row?.getAttribute("data-rc-host-status")).toBe("connecting");
				expect(records[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN_A}` });
				// The token never stays in the address bar.
				expect(window.location.hash).toBe("");
				// The appearance panel's persistence failure is equally silent.
				expect(document.querySelector("[data-rc-region='header']")).not.toBeNull();
			} finally {
				await mounted.unmount();
			}
		} finally {
			setItem.mockRestore();
			window.location.hash = "";
		}
	});
});

describe("components: sliding pill", () => {
	/** happy-dom has no layout, so the pill's measured geometry is simulated by
	 * stubbing the offset getters the component reads (options sit on a 64px
	 * grid, each 60px wide). */
	function stubPillLayout(): Array<MockInstance> {
		const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
			if (!this.classList.contains("rc-pill-btn") || this.parentElement === null) return 0;
			const options = Array.from(this.parentElement.children).filter(
				(node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("rc-pill-btn"),
			);
			return options.indexOf(this) * 64;
		});
		const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("rc-pill-btn") ? 60 : 0;
		});
		return [left, width];
	}

	it("measures the active option and moves the thumb geometry on click", async () => {
		const spies = stubPillLayout();
		const picked: string[] = [];
		const pill = (active: "a" | "b" | "c"): ReactElement => (
			<SlidingPill
				options={[
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
					{ value: "c", label: "C", props: { "data-rc-pill-opt": "c" } },
				]}
				active={active}
				onChange={(value) => picked.push(value)}
				ariaLabel="pick"
			/>
		);
		const mounted = await mount(pill("a"));
		try {
			await flush();
			const buttons = Array.from(document.querySelectorAll<HTMLElement>(".rc-pill-btn"));
			expect(buttons).toHaveLength(3);
			// aria-pressed carries the selection, never color alone.
			expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
			expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
			// Option props (test hooks) pass through to the rendered button.
			expect(buttons[2]?.getAttribute("data-rc-pill-opt")).toBe("c");
			// Initial measurement: the thumb sits under option A.
			const thumb = document.querySelector<HTMLElement>(".rc-pill-thumb");
			expect(thumb?.style.transform).toBe("translateX(0px)");
			expect(thumb?.style.width).toBe("60px");
			// Clicking C reports the pick; the controlled active follows, the
			// pressed states flip, and the thumb glides to C's slot.
			await click(buttons[2] ?? null);
			expect(picked).toEqual(["c"]);
			await mounted.render(pill("c"));
			expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
			expect(buttons[2]?.getAttribute("aria-pressed")).toBe("true");
			expect(thumb?.style.transform).toBe("translateX(128px)");
		} finally {
			for (const spy of spies) spy.mockRestore();
			await mounted.unmount();
		}
	});

	it("re-measures the thumb when a ResizeObserver reports a size change", async () => {
		const spies = stubPillLayout();
		let notify: () => void = () => undefined;
		class StubObserver {
			constructor(callback: () => void) {
				notify = callback;
			}
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal("ResizeObserver", StubObserver);
		const mounted = await mount(
			<SlidingPill options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} active="a" onChange={() => undefined} ariaLabel="pick" />,
		);
		try {
			await flush();
			const thumb = document.querySelector<HTMLElement>(".rc-pill-thumb");
			expect(thumb?.style.width).toBe("60px");
			spies[1]?.mockImplementation(function (this: HTMLElement) {
				return this.classList.contains("rc-pill-btn") ? 90 : 0;
			});
			await act(async () => {
				notify();
			});
			expect(thumb?.style.width).toBe("90px");
		} finally {
			vi.unstubAllGlobals();
			for (const spy of spies) spy.mockRestore();
			await mounted.unmount();
		}
	});

	it("carries the delivery mode as a labelled segmented control with aria-pressed semantics", async () => {
		const sent: Array<[string, string]> = [];
		const mounted = await mount(
			<Composer
				hostId="h1"
				queue={null}
				disabled={false}
				onSend={(text, deliverAs) => {
					sent.push([text, deliverAs]);
					return Promise.resolve({ ok: true, status: 202 });
				}}
				onAbort={() => Promise.resolve({ ok: true, status: 202 })}
			/>,
		);
		try {
			await flush();
			const group = document.querySelector("[data-rc-deliver-as]");
			expect(group?.getAttribute("data-rc-deliver-as")).toBe("followUp");
			const followUp = document.querySelector('[data-rc-deliver-mode="followUp"]');
			const steer = document.querySelector('[data-rc-deliver-mode="steer"]');
			expect(followUp?.getAttribute("aria-pressed")).toBe("true");
			expect(steer?.getAttribute("aria-pressed")).toBe("false");
			// Switching modes updates the group's value and the pressed states.
			await click(steer);
			expect(document.querySelector("[data-rc-deliver-as]")?.getAttribute("data-rc-deliver-as")).toBe("steer");
			expect(steer?.getAttribute("aria-pressed")).toBe("true");
			expect(followUp?.getAttribute("aria-pressed")).toBe("false");
			// The prompt posts with the active mode.
			await act(async () => {
				setNativeValue(document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]") as HTMLTextAreaElement, "go");
			});
			await click(document.querySelector("[data-rc-send]"));
			expect(sent).toEqual([["go", "steer"]]);
		} finally {
			await mounted.unmount();
		}
	});

	it("sends on Enter, inserts a newline on Shift+Enter, and ignores Enter during IME composition", async () => {
		const sent: Array<[string, string]> = [];
		const mounted = await mount(
			<Composer hostId="h1" queue={null} disabled={false} onSend={(text, deliverAs) => {
					sent.push([text, deliverAs]);
					return Promise.resolve({ ok: true, status: 202 });
				}} onAbort={() => Promise.resolve({ ok: true, status: 202 })} />,
		);
		try {
			await flush();
			const input = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]") as HTMLTextAreaElement;
			const press = async (init: KeyboardEventInit): Promise<boolean> => {
				const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
				await act(async () => {
					input.dispatchEvent(event);
				});
				return event.defaultPrevented;
			};
			await act(async () => {
				setNativeValue(input, "line one");
			});
			// Shift+Enter is left to the browser (a newline) and sends nothing.
			expect(await press({ shiftKey: true })).toBe(false);
			expect(sent).toEqual([]);
			// IME composition: Enter confirms the candidate, it must not send.
			expect(await press({ isComposing: true })).toBe(false);
			expect(sent).toEqual([]);
			expect(await press({})).toBe(true);
			expect(sent).toEqual([["line one", "followUp"]]);
			expect(input.value).toBe("");
			// Cmd/Ctrl+Enter still sends.
			await act(async () => {
				setNativeValue(input, "line two");
			});
			await press({ ctrlKey: true });
			await act(async () => {
				setNativeValue(input, "line three");
			});
			await press({ metaKey: true });
			expect(sent.map(([text]) => text)).toEqual(["line one", "line two", "line three"]);
		} finally {
			await mounted.unmount();
		}
	});

	it("offers the stop button only while the agent works", async () => {
		const mounted = await mount(<Composer hostId="h1" queue={null} disabled={false} working={false} onSend={() => Promise.resolve({ ok: true, status: 202 })} onAbort={() => Promise.resolve({ ok: true, status: 202 })} />);
		try {
			await flush();
			expect(document.querySelector("[data-rc-abort]")).toBeNull();
			await mounted.render(<Composer hostId="h1" queue={null} disabled={false} working onSend={() => Promise.resolve({ ok: true, status: 202 })} onAbort={() => Promise.resolve({ ok: true, status: 202 })} />);
			expect(document.querySelector("[data-rc-abort]")?.getAttribute("aria-label")).toBe("abort");
			await mounted.render(<Composer hostId="h1" queue={null} disabled={false} working={false} onSend={() => Promise.resolve({ ok: true, status: 202 })} onAbort={() => Promise.resolve({ ok: true, status: 202 })} />);
			expect(document.querySelector("[data-rc-abort]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});

describe("components: rolling number", () => {
	it("renders one rolling column per digit and translates to the target value", async () => {
		const mounted = await mount(<RollingNumber value={42} />);
		try {
			const roll = document.querySelector(".rc-roll");
			// The digits are decorative: the caller carries the accessible label.
			expect(roll?.getAttribute("aria-hidden")).toBe("true");
			const columns = document.querySelectorAll<HTMLElement>(".rc-roll-column");
			expect(columns).toHaveLength(2);
			expect(columns[0]?.style.transform).toBe("translateY(-4em)");
			expect(columns[1]?.style.transform).toBe("translateY(-2em)");
			// A value change moves the affected column without remounting it.
			await mounted.render(<RollingNumber value={47} />);
			expect(columns[0]?.style.transform).toBe("translateY(-4em)");
			expect(columns[1]?.style.transform).toBe("translateY(-7em)");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("renderer: transcript arrivals", () => {
	function entry(id: string): WireTranscriptEntry {
		return { entryId: id, message: { role: "user", blocks: [{ type: "text", text: `msg ${id}` }] } };
	}

	it("stamps data-rc-arrived only on entries that land after the first snapshot", async () => {
		const mounted = await mount(<TranscriptList entries={[entry("a"), entry("b")]} />);
		try {
			await flush();
			// Baseline snapshot: nothing animates.
			expect(document.querySelectorAll('[data-rc-arrived="true"]')).toHaveLength(0);
			// A later arrival animates; the baseline stays static.
			await mounted.render(<TranscriptList entries={[entry("a"), entry("b"), entry("c")]} />);
			expect(document.querySelector('[data-entry-id="c"]')?.getAttribute("data-rc-arrived")).toBe("true");
			expect(document.querySelector('[data-entry-id="a"]')?.getAttribute("data-rc-arrived")).toBeNull();
			// A wholesale replacement (host switch, replay reset) re-baselines:
			// none of the new population animates.
			await mounted.render(<TranscriptList entries={[entry("x"), entry("y")]} />);
			expect(document.querySelectorAll('[data-rc-arrived="true"]')).toHaveLength(0);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("connection: stalled stream watchdog", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("recycles a stream silent for 3 heartbeats through the Last-Event-ID reconnect path", async () => {
		vi.useFakeTimers();
		const records: RecordedFetch[] = [];
		const states: ConnectionState[] = [];
		const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
			records.push({ url: url.toString(), init });
			return Promise.resolve(fakeResponse({ ok: true, status: 200, body: liveStreamOf([new TextEncoder().encode("id: 9\ndata: {}\n\n")]) }));
		};
		const connection = connectSse({
			origin: "http://127.0.0.1:9",
			token: "secret",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			onFrame: () => undefined,
			onState: (state) => states.push(state),
		});
		await vi.advanceTimersByTimeAsync(44_999);
		expect(records).toHaveLength(1);
		expect(states.at(-1)).toBe("connected");
		await vi.advanceTimersByTimeAsync(1);
		expect(states.at(-1)).toBe("reconnecting");
		await vi.advanceTimersByTimeAsync(250);
		expect(records).toHaveLength(2);
		expect(records[1]?.init?.headers).toMatchObject({ "last-event-id": "9" });
		connection.close();
	});

	it("any received bytes re-arm the watchdog", async () => {
		vi.useFakeTimers();
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const fetchMock = vi.fn(() => Promise.resolve(fakeResponse({ ok: true, status: 200, body })));
		const connection = connectSse({ origin: "http://127.0.0.1:9", token: "secret", fetchImpl: fetchMock as unknown as typeof fetch, onFrame: () => undefined, onState: () => undefined });
		await vi.advanceTimersByTimeAsync(40_000);
		(controller as ReadableStreamDefaultController<Uint8Array> | null)?.enqueue(new TextEncoder().encode(": ping\n\n"));
		await vi.advanceTimersByTimeAsync(40_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		connection.close();
	});
});

describe("store: fail-safe and correctness", () => {
	const STATUS: WireStatus = { kind: "idle", model: null };
	const SNAP: SnapshotPayload = {
		host: { origin: "http://127.0.0.1:9", label: "main" },
		protocolVersion: 1,
		sessionId: "s1",
		sessionName: "one",
		status: STATUS,
		messages: [],
		holds: [],
		queue: { items: [], terminalQueued: 0 },
	};
	const ensured = (): HostStore => reduceHosts({}, { type: "ensure", hostId: "h1", label: "lab", origin: "http://127.0.0.1:9" });
	const apply = (store: HostStore, event: AnyRemoteEvent, receivedAt = 1000): HostStore => reduceHosts(store, { type: "event", hostId: "h1", event, receivedAt });

	it("keeps the state and records the seq when a payload is malformed", () => {
		const good = apply(ensured(), makeEvent("snapshot", 1, SNAP));
		const bad = apply(good, { v: 1, seq: 2, ts: TS, type: "snapshot", payload: { sessionId: "x" } } as unknown as AnyRemoteEvent);
		expect(bad.h1?.sessionId).toBe("s1");
		expect(bad.h1?.lastSeq).toBe(2);
		const badStatus = apply(good, { v: 1, seq: 3, ts: TS, type: "status", payload: {} } as unknown as AnyRemoteEvent);
		expect(badStatus.h1?.status).toEqual(STATUS);
		expect(badStatus.h1?.lastSeq).toBe(3);
		const throwing = apply(good, { v: 1, seq: 4, ts: TS, type: "approval", payload: {} } as unknown as AnyRemoteEvent);
		expect(throwing.h1?.holds).toEqual([]);
		expect(throwing.h1?.lastSeq).toBe(4);
	});

	it("an activity end clears only the same kind; a snapshot carries its own activity", () => {
		let store = apply(ensured(), makeEvent("snapshot", 1, SNAP));
		store = apply(store, makeEvent("activity", 2, { activity: { kind: "compaction", phase: "start" } }));
		store = apply(store, makeEvent("activity", 3, { activity: { kind: "memory_fold", phase: "end" } }));
		expect(store.h1?.activity?.kind).toBe("compaction");
		store = apply(store, makeEvent("activity", 4, { activity: { kind: "compaction", phase: "end" } }));
		expect(store.h1?.activity).toBeNull();
		store = apply(store, makeEvent("snapshot", 5, { ...SNAP, activity: { kind: "memory_fold", phase: "failed" } }));
		expect(store.h1?.activity).toEqual({ kind: "memory_fold", phase: "failed" });
		store = apply(store, makeEvent("snapshot", 6, SNAP));
		expect(store.h1?.activity).toBeNull();
	});

	it("a different session resets tok/s and activity; a snapshot clears tool updates", () => {
		let store = apply(ensured(), makeEvent("snapshot", 1, SNAP));
		store = apply(store, makeEvent("status", 2, { status: { kind: "working", model: null, stats: { tokensPerSecond: 30 } } }));
		store = apply(store, makeEvent("activity", 3, { activity: { kind: "compaction", phase: "start" } }));
		store = apply(store, makeEvent("tool_update", 4, { toolCallId: "t1", phase: "update", toolName: "bash", partialResult: "x" }));
		expect(store.h1?.toolUpdates.size).toBe(1);
		const same = apply(store, makeEvent("session", 5, { sessionId: "s1", sessionName: "renamed" }));
		expect(same.h1?.lastTokensPerSecond).toBe(30);
		expect(same.h1?.activity).not.toBeNull();
		const other = apply(store, makeEvent("session", 6, { sessionId: "s2", sessionName: "two" }));
		expect(other.h1?.lastTokensPerSecond).toBeNull();
		expect(other.h1?.activity).toBeNull();
		const snap = apply(store, makeEvent("snapshot", 7, { ...SNAP, sessionId: "s2" }));
		expect(snap.h1?.lastTokensPerSecond).toBeNull();
		expect(snap.h1?.toolUpdates.size).toBe(0);
	});

	it("tracks the host clock offset from event ts and ignores unparsable ts", () => {
		const sent = Date.parse(TS);
		let store = apply(ensured(), makeEvent("ping", 1, {}), sent + 5000);
		expect(store.h1?.clockOffsetMs).toBe(5000);
		store = apply(store, { v: 1, seq: 2, ts: "garbage", type: "ping", payload: {} } as AnyRemoteEvent, sent + 9000);
		expect(store.h1?.clockOffsetMs).toBe(5000);
	});

	it("forget drops a host's state", () => {
		const store = reduceHosts(ensured(), { type: "forget", hostId: "h1" });
		expect(store.h1).toBeUndefined();
	});
});

describe("hosts: strict origins and token adoption", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	const fakeLocation = { origin: "http://127.0.0.1:59711", pathname: "/", search: "" } as unknown as Location;

	it("requires an absolute http(s) URL and stores url.origin so default ports dedupe", () => {
		const message = "origin must be an http(s) URL, e.g. http://127.0.0.1:8080";
		expect(() => addHost({ label: "x", origin: "example.com", token: "t" })).toThrow(message);
		expect(() => addHost({ label: "x", origin: "ftp://example.com", token: "t" })).toThrow(message);
		const added = addHost({ label: "x", origin: "http://example.com:80/path", token: "t" });
		expect(added.origin).toBe("http://example.com");
		expect(() => addHost({ label: "y", origin: "http://example.com", token: "t" })).toThrow("already exists");
		expect(() => updateHost(added.id, { origin: "nope" })).toThrow(message);
		updateHost(added.id, { token: "  padded  " });
		expect(listHosts()[0]?.token).toBe("padded");
	});

	it("drops later registry entries repeating an id or origin", () => {
		const raw = JSON.stringify([
			{ id: "a", origin: "http://x:1", token: "t" },
			{ id: "a", origin: "http://y:1", token: "t" },
			{ id: "b", origin: "http://x:1/", token: "t" },
			{ id: "c", origin: "not a url", token: "t" },
			{ id: "d", origin: "http://z:1", token: "t" },
		]);
		expect(parseHosts(raw).map((host) => host.id)).toEqual(["a", "d"]);
	});

	it("adopts only a fragment shaped like the server token and leaves any other untouched", () => {
		const history = { replaceState: vi.fn() } as unknown as History;
		expect(adoptLocalHost("#section-2", fakeLocation, history)).toBeNull();
		expect(adoptLocalHost("#" + "a".repeat(31), fakeLocation, history)).toBeNull();
		expect(adoptLocalHost("#" + "a".repeat(63) + "!", fakeLocation, history)).toBeNull();
		expect(history.replaceState).not.toHaveBeenCalled();
		expect(listHosts()).toEqual([]);
		expect(adoptLocalHost("#" + "0123456789abcdef".repeat(4), fakeLocation, history)?.token).toHaveLength(64);
		expect(history.replaceState).toHaveBeenCalledTimes(1);
	});
});

describe("components: composer failures, availability, and drafts", () => {
	function composerProps(over: Partial<Parameters<typeof Composer>[0]> = {}): Parameters<typeof Composer>[0] {
		return {
			hostId: "h1",
			queue: null,
			disabled: false,
			onSend: () => Promise.resolve({ ok: true, status: 202 }),
			onAbort: () => Promise.resolve({ ok: true, status: 202 }),
			...over,
		};
	}
	const type = (text: string) =>
		act(async () => {
			setNativeValue(document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]") as HTMLTextAreaElement, text);
		});

	it("keeps the draft and shows an alert on a failed send, then clears it on edit", async () => {
		const mounted = await mount(<Composer {...composerProps({ onSend: () => Promise.resolve({ ok: false, status: 401 }) })} />);
		try {
			await type("keep me");
			await click(document.querySelector("[data-rc-send]"));
			const input = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]");
			expect(input?.value).toBe("keep me");
			const error = document.querySelector("[data-rc-send-error]");
			expect(error?.getAttribute("role")).toBe("alert");
			expect(error?.textContent).toBe("Not sent: unauthorized (status 401)");
			await type("keep me!");
			expect(document.querySelector("[data-rc-send-error]")).toBeNull();
			await mounted.render(<Composer {...composerProps({ onSend: () => Promise.resolve({ ok: false, status: 0 }) })} />);
			await click(document.querySelector("[data-rc-send]"));
			expect(document.querySelector("[data-rc-send-error]")?.textContent).toBe("Not sent: host unreachable");
			await mounted.render(<Composer {...composerProps({ onSend: () => Promise.resolve({ ok: false, status: 503 }) })} />);
			await click(document.querySelector("[data-rc-send]"));
			expect(document.querySelector("[data-rc-send-error]")?.textContent).toBe("Not sent: status 503");
		} finally {
			await mounted.unmount();
		}
	});

	it("disables send while a send is in flight and clears the error after a success", async () => {
		let finish: (result: { ok: boolean; status: number }) => void = () => undefined;
		const onSend = vi.fn(() => new Promise<{ ok: boolean; status: number }>((resolve) => (finish = resolve)));
		const mounted = await mount(<Composer {...composerProps({ onSend })} />);
		try {
			await type("once");
			await click(document.querySelector("[data-rc-send]"));
			expect(document.querySelector<HTMLButtonElement>("[data-rc-send]")?.disabled).toBe(true);
			await click(document.querySelector("[data-rc-send]"));
			expect(onSend).toHaveBeenCalledTimes(1);
			await act(async () => finish({ ok: true, status: 202 }));
			expect(document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]")?.value).toBe("");
			expect(document.querySelector("[data-rc-send-error]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("shows an error line when abort fails", async () => {
		const mounted = await mount(<Composer {...composerProps({ working: true, onAbort: () => Promise.resolve({ ok: false, status: 0 }) })} />);
		try {
			await click(document.querySelector("[data-rc-abort]"));
			expect(document.querySelector("[data-rc-send-error]")?.textContent).toContain("host unreachable");
		} finally {
			await mounted.unmount();
		}
	});

	it("names why the composer is disabled in the placeholder", async () => {
		const mounted = await mount(<Composer {...composerProps({ disabled: true, disabledReason: "reconnecting..." })} />);
		try {
			const input = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]");
			expect(input?.placeholder).toBe("reconnecting...");
			expect(input?.disabled).toBe(true);
		} finally {
			await mounted.unmount();
		}
	});

	it("disables the delivery pill and marks the container when the composer is disabled", async () => {
		const mounted = await mount(<Composer {...composerProps({ disabled: true })} />);
		try {
			const pills = document.querySelectorAll<HTMLButtonElement>("[data-rc-deliver-mode]");
			expect(pills.length).toBe(2);
			for (const pill of pills) expect(pill.disabled).toBe(true);
			expect(document.querySelector("[data-rc-composer]")?.getAttribute("data-rc-disabled")).toBe("true");
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps the delivery pill enabled and the container unmarked when the composer is enabled", async () => {
		const mounted = await mount(<Composer {...composerProps()} />);
		try {
			for (const pill of document.querySelectorAll<HTMLButtonElement>("[data-rc-deliver-mode]")) expect(pill.disabled).toBe(false);
			expect(document.querySelector("[data-rc-composer]")?.hasAttribute("data-rc-disabled")).toBe(false);
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps one draft and delivery mode per host", async () => {
		const mounted = await mount(<Composer {...composerProps({ hostId: "A" })} />);
		try {
			await type("for A");
			await click(document.querySelector('[data-rc-deliver-mode="steer"]'));
			await mounted.render(<Composer {...composerProps({ hostId: "B" })} />);
			const input = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]");
			expect(input?.value).toBe("");
			expect(document.querySelector("[data-rc-deliver-as]")?.getAttribute("data-rc-deliver-as")).toBe("followUp");
			await type("for B");
			await mounted.render(<Composer {...composerProps({ hostId: "A" })} />);
			expect(document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]")?.value).toBe("for A");
			expect(document.querySelector("[data-rc-deliver-as]")?.getAttribute("data-rc-deliver-as")).toBe("steer");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("components: approval card resilience", () => {
	const hold = (over: Partial<WireApproval> = {}): WireApproval => ({ id: "a1", toolName: "bash", argsPreview: "ls", deadlineMs: Date.now() + 60_000, createdAt: TS, ...over });

	it("disables both buttons while resolving, posts once, and shows an alert on failure", async () => {
		let finish: (result: { ok: boolean; status: number }) => void = () => undefined;
		const onResolve = vi.fn(() => new Promise<{ ok: boolean; status: number }>((resolve) => (finish = resolve)));
		const mounted = await mount(<ApprovalCard holds={[hold()]} onResolve={onResolve} />);
		try {
			await click(document.querySelector('[data-rc-approve="a1"]'));
			expect(document.querySelector<HTMLButtonElement>('[data-rc-approve="a1"]')?.disabled).toBe(true);
			expect(document.querySelector<HTMLButtonElement>('[data-rc-deny="a1"]')?.disabled).toBe(true);
			await click(document.querySelector('[data-rc-approve="a1"]'));
			expect(onResolve).toHaveBeenCalledTimes(1);
			await act(async () => finish({ ok: false, status: 0 }));
			const error = document.querySelector("[data-rc-approval-error]");
			expect(error?.getAttribute("role")).toBe("alert");
			expect(error?.textContent).toContain("host unreachable");
			expect(error?.textContent).toContain("may still expire");
			expect(document.querySelector<HTMLButtonElement>('[data-rc-approve="a1"]')?.disabled).toBe(false);
		} finally {
			await mounted.unmount();
		}
	});

	it("discloses long args with Show all / Show less and exposes group semantics in a live region", async () => {
		const args = "line one\nline two\nline three\nline four";
		const mounted = await mount(<ApprovalCard holds={[hold({ argsPreview: args })]} onResolve={() => Promise.resolve({ ok: true, status: 202 })} />);
		try {
			const card = document.querySelector("[data-rc-approval]");
			expect(card?.getAttribute("role")).toBe("group");
			expect(card?.getAttribute("aria-label")).toBe("approval needed: bash");
			expect(card?.closest("[aria-live]")?.getAttribute("aria-live")).toBe("assertive");
			const more = document.querySelector("[data-rc-approval-more]");
			expect(more?.textContent).toBe("Show all");
			expect(more?.getAttribute("aria-expanded")).toBe("false");
			expect(document.querySelector("[data-rc-approval-args]")?.getAttribute("data-rc-approval-args")).toBe("clamped");
			await click(more);
			expect(document.querySelector("[data-rc-approval-more]")?.textContent).toBe("Show less");
			expect(document.querySelector("[data-rc-approval-args]")?.getAttribute("data-rc-approval-args")).toBe("expanded");
			expect(document.querySelector("[data-rc-approval-args]")?.textContent).toBe(args);
		} finally {
			await mounted.unmount();
		}
	});

	it("short args get no disclosure", async () => {
		const mounted = await mount(<ApprovalCard holds={[hold()]} onResolve={() => Promise.resolve({ ok: true, status: 202 })} />);
		try {
			expect(document.querySelector("[data-rc-approval-more]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("counts down against the host clock and refreshes at once when a hold arrives", async () => {
		const onResolve = () => Promise.resolve({ ok: true, status: 202 });
		// Host clock runs 1h behind the browser: the browser sees the deadline 1h + 30s ahead of its own clock minus offset.
		const skew = 3_600_000;
		const mounted = await mount(<ApprovalCard holds={[]} clockOffsetMs={skew} onResolve={onResolve} />);
		try {
			await mounted.render(<ApprovalCard holds={[hold({ deadlineMs: Date.now() - skew + 30_000 })]} clockOffsetMs={skew} onResolve={onResolve} />);
			const seconds = Number(document.querySelector("[data-rc-countdown]")?.getAttribute("data-rc-countdown"));
			expect(seconds).toBeGreaterThan(27);
			expect(seconds).toBeLessThanOrEqual(30);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("app: availability and recovery", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.unstubAllGlobals();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("disables the composer and hides stop on an unauthorized host", async () => {
		seedRegistry();
		const unauthorized = (() => Promise.resolve(fakeResponse({ status: 401 }))) as unknown as typeof fetch;
		vi.stubGlobal("fetch", unauthorized);
		const mounted = await mount(<App />);
		try {
			await flush();
			const input = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]");
			expect(input?.disabled).toBe(true);
			expect(input?.placeholder).toBe("unauthorized: reopen the /remote-control URL");
			expect(document.querySelector("[data-rc-abort]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps stop reachable right after connect while status is still unknown", async () => {
		seedRegistry();
		vi.stubGlobal("fetch", consoleFetch([], []));
		const mounted = await mount(<App />);
		try {
			await flush();
			expect(document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]")?.disabled).toBe(false);
			expect(document.querySelector("[data-rc-abort]")).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});
