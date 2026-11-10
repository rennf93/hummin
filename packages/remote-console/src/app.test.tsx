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
import { act } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import {
	connectSse,
	consumeStream,
	parseProtocolEvent,
	postApproval,
	SseFrameParser,
	type ConnectionState,
	type SseConnection,
	type SseFrame,
} from "./connection.ts";
import { ApprovalCard, countdownSeconds } from "./components/ApprovalCard.tsx";
import { railStatus } from "./components/HostRail.tsx";
import type {
	AnyRemoteEvent,
	RemoteEventPayloadMap,
	RemoteEventType,
	SnapshotPayload,
	WireApproval,
} from "./harness/replay-log.ts";
import {
	addHost,
	adoptLocalHost,
	applyAppearance,
	clampAccentHue,
	clampDensity,
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

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
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

const TEST_HOST = { id: "h1", label: "main", origin: "http://127.0.0.1:9", token: "secret" };

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
});

describe("store: per-host reducer", () => {
	const SNAPSHOT: SnapshotPayload = {
		host: { origin: "http://127.0.0.1:9", label: "main" },
		protocolVersion: 1,
		sessionId: "s1",
		sessionName: "session one",
		status: { kind: "idle", model: { provider: "acme", modelId: "big-1" }, thinkingLevel: "high", contextUsage: { tokens: 100, contextWindow: 200, percent: 50 } },
		messages: [{ entryId: "e0", message: { role: "user", blocks: [{ type: "text", text: "hello doc" }] } }],
		approval: null,
		queue: { items: [{ id: "q1", preview: "queued text", deliverAs: "steer" }], terminalQueued: 2 },
	};

	function ensured(): HostStore {
		return reduceHosts({}, { type: "ensure", hostId: "h1", label: "lab", origin: "http://127.0.0.1:9" });
	}

	function dispatch(store: HostStore, event: AnyRemoteEvent, receivedAt = 1000): HostStore {
		return reduceHosts(store, { type: "event", hostId: "h1", event, receivedAt });
	}

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
		expect(state?.approval).toBeNull();
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

	it("a delta without a start opens an implicit slot (coalescing tolerance)", () => {
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

	it("status, queue, session, and approval events replace their slices", () => {
		let store = dispatch(ensured(), makeEvent("snapshot", 0, SNAPSHOT));
		store = dispatch(store, makeEvent("status", 1, { status: { kind: "working", model: { provider: "acme", modelId: "big-1" }, contextUsage: { tokens: null, contextWindow: 200, percent: 12 } } }));
		expect(store.h1?.status?.kind).toBe("working");
		expect(store.h1?.status?.thinkingLevel).toBeUndefined();
		store = dispatch(store, makeEvent("queue", 2, { queue: { items: [], terminalQueued: 1 } }));
		expect(store.h1?.queue).toEqual({ items: [], terminalQueued: 1 });
		store = dispatch(store, makeEvent("session", 3, { sessionId: "s2", sessionName: "renamed" }));
		expect(store.h1?.sessionId).toBe("s2");
		expect(store.h1?.sessionName).toBe("renamed");
		const approval: WireApproval = { id: "a1", toolName: "edit", argsPreview: "/tmp/x", deadlineMs: 9999, createdAt: TS };
		store = dispatch(store, makeEvent("approval", 4, { approval }));
		expect(store.h1?.approval).toEqual(approval);
		store = dispatch(store, makeEvent("approval_done", 5, { id: "other", resolution: "expired" }));
		expect(store.h1?.approval).toEqual(approval);
		store = dispatch(store, makeEvent("approval_done", 6, { id: "a1", resolution: "denied" }));
		expect(store.h1?.approval).toBeNull();
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
		expect(parseAppearance(null)).toEqual({ preset: "glass", accentHue: 190, density: 1, motion: "auto" });
		expect(parseAppearance("garbage")).toEqual({ preset: "glass", accentHue: 190, density: 1, motion: "auto" });
		expect(parseAppearance(JSON.stringify({ preset: "terminal", accentHue: 400, density: 9 }))).toEqual({ preset: "terminal", accentHue: 190, density: 1, motion: "auto" });
		// Records saved before the motion axis existed parse as "auto"; an unknown
		// motion value falls back the same way.
		expect(parseAppearance(JSON.stringify({ preset: "paper", accentHue: 200, density: 1.5 }))).toEqual({ preset: "paper", accentHue: 200, density: 1.5, motion: "auto" });
		expect(parseAppearance(JSON.stringify({ motion: "off" }))).toEqual({ preset: "glass", accentHue: 190, density: 1, motion: "off" });
		expect(parseAppearance(JSON.stringify({ motion: "sometimes" }))).toMatchObject({ motion: "auto" });
		const appearance: Appearance = { preset: "paper", accentHue: 250, density: 0.85, motion: "off" };
		saveAppearance(appearance);
		expect(loadAppearance()).toEqual(appearance);
		applyAppearance(document.documentElement, appearance);
		expect(document.documentElement.dataset.rcPreset).toBe("paper");
		expect(document.documentElement.dataset.rcMotion).toBe("off");
		expect(document.documentElement.style.getPropertyValue("--rc-accent-hue")).toBe("250");
		expect(document.documentElement.style.getPropertyValue("--rc-density")).toBe("0.85");
	});

	it("clamps the live axes onto their ranges", () => {
		expect(clampAccentHue(190)).toBe(190);
		expect(clampAccentHue(-20)).toBe(0);
		expect(clampAccentHue(400)).toBe(360);
		expect(clampAccentHue(250.6)).toBe(251);
		expect(clampAccentHue(Number.NaN)).toBe(190);
		expect(clampDensity(1)).toBe(1);
		expect(clampDensity(0.1)).toBe(0.5);
		expect(clampDensity(9)).toBe(2);
		expect(clampDensity(1.234)).toBe(1.25);
		expect(clampDensity(Number.NaN)).toBe(1);
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
		const entry = adoptLocalHost("#tok-live", location, history);
		expect(entry).toMatchObject({ origin: "http://127.0.0.1:59711", token: "tok-live" });
		// the registry stores the token (browser-side by design); the URL must not
		expect(history.replaceState).toHaveBeenCalledWith(null, "", location.pathname + location.search);
	});

	it("rotates the token for an existing origin entry instead of duplicating it", () => {
		const location = fakeLocation("http://127.0.0.1:59711");
		const history = fakeHistory();
		const first = adoptLocalHost("#tok-1", location, history);
		const second = adoptLocalHost("#tok-2", location, history);
		expect(second?.id).toBe(first?.id);
		expect(second?.token).toBe("tok-2");
		expect(listHosts()).toHaveLength(1);
		expect(listHosts()[0]?.token).toBe("tok-2");
	});

	it("returns null and touches nothing without a fragment token", () => {
		const location = fakeLocation("http://127.0.0.1:59711");
		const history = fakeHistory();
		expect(adoptLocalHost("", location, history)).toBeNull();
		expect(adoptLocalHost("#", location, history)).toBeNull();
		expect(history.replaceState).not.toHaveBeenCalled();
		expect(listHosts()).toEqual([]);
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
			expect(document.querySelector('[data-rc-appear-swatch="glass"]')).not.toBeNull();
			expect(document.querySelector("[data-rc-appear-hue]")).not.toBeNull();
			expect(document.querySelector("[data-rc-appear-density]")).not.toBeNull();
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

	it("applies preset, hue, density, and motion live and persists them", async () => {
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
			const density = document.querySelector<HTMLInputElement>("[data-rc-appear-density]");
			await act(async () => {
				setNativeValue(density as HTMLInputElement, "0.85");
			});
			expect(document.documentElement.style.getPropertyValue("--rc-density")).toBe("0.85");
			// Motion off applies the root attribute.
			await click(document.querySelector('[data-rc-appear-motion="off"]'));
			expect(document.documentElement.dataset.rcMotion).toBe("off");
			// Everything persisted in the same tick.
			const saved = JSON.parse(localStorage.getItem("rc.appearance") ?? "{}") as { preset?: string; accentHue?: number; density?: number; motion?: string };
			expect(saved).toEqual({ preset: "paper", accentHue: 250, density: 0.85, motion: "off" });
			// The panel's readouts track the applied values.
			expect(document.querySelector("[data-rc-appear-hue-value]")?.getAttribute("data-rc-appear-hue-value")).toBe("250");
			expect(document.querySelector("[data-rc-appear-density-value]")?.getAttribute("data-rc-appear-density-value")).toBe("0.85");
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
			approval: null,
			queue: { items: [{ id: "q1", preview: "queued text", deliverAs: "steer" }], terminalQueued: 2 },
		};
		const approvalEvent = makeEvent("approval", 1, { approval: { id: "a1", toolName: "bash", argsPreview: "rm -rf /tmp/scratch", deadlineMs: Date.now() + 120_000, createdAt: TS } });
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
			await click(document.querySelector("[data-rc-approve]"));
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
			expect(document.documentElement.dataset.rcPreset).toBe("glass");
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
			expect(document.documentElement.style.getPropertyValue("--rc-density")).toBe("0.85");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders the approval card hidden when no approval is pending", async () => {
		localStorage.clear();
		const records: RecordedFetch[] = [];
		vi.stubGlobal("fetch", hangingFetch(records));
		const mounted = await mount(<ApprovalCard approval={null} onResolve={() => undefined} />);
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
			expect(document.querySelector(".rc-add-fields")?.getAttribute("data-rc-add-open")).toBe("false");
		} finally {
			await mounted.unmount();
		}
	});
});
