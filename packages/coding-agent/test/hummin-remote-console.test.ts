/**
 * Tests for the hummin remote console extension server: real HTTP against
 * 127.0.0.1 on an ephemeral port via fetch. Covers the SSE contract (frames,
 * replay, stale and ahead-of-head cursors, backpressure disconnect with
 * lossless replay), the action endpoints with their idempotency map, the
 * opt-in approval holds (single and concurrent), CORS for registered console
 * origins, the origins store, the config resolution, the event mapping from
 * pi runtime events to protocol frames, and the carried security perimeter.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import remoteExtension from "../extensions/hummin-remote.ts";
import { ApprovalRegistry } from "../extensions/lib/remote-console/approvals.ts";
import { ConsoleEventSource, ReplayLog } from "../extensions/lib/remote-console/event-source.ts";
import {
	type RemoteConsoleHandle,
	type RemoteConsoleOptions,
	resolveRemoteConsoleConfig,
	startRemoteConsole,
} from "../extensions/lib/remote-console/index.ts";
import type { SnapshotPayload } from "../extensions/lib/remote-console/protocol.ts";
import { openConsoleOriginStore } from "../extensions/lib/remote-console/store.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/index.ts";

// --- fixtures ----------------------------------------------------------------

type RegisteredHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakePi {
	pi: ExtensionAPI;
	fire(event: string, payload: unknown, ctx?: ExtensionContext): unknown[];
	handlers(event: string): RegisteredHandler[];
}

function fakeContext(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "sess-test",
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function fakePi(settings: unknown = {}): FakePi {
	const registered = new Map<string, RegisteredHandler[]>();
	const on = (event: string, handler: RegisteredHandler): (() => void) => {
		const list = registered.get(event) ?? [];
		list.push(handler);
		registered.set(event, list);
		return () =>
			registered.set(
				event,
				list.filter((kept) => kept !== handler),
			);
	};
	return {
		fire: (event, payload, ctx) =>
			(registered.get(event) ?? []).map((handler) => handler(payload, ctx ?? fakeContext())),
		handlers: (event) => registered.get(event) ?? [],
		pi: { on, getSettings: () => settings, getSessionName: () => undefined } as unknown as ExtensionAPI,
	};
}

interface StartedConsole {
	tmp: string;
	fake: FakePi;
	sendPrompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	handle: RemoteConsoleHandle;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
	vi.useRealTimers();
});

async function startTestConsole(overrides: Partial<RemoteConsoleOptions> = {}): Promise<StartedConsole> {
	const tmp = mkdtempSync(join(tmpdir(), "remote-console-test-"));
	const fake = fakePi();
	const sendPrompt = vi.fn<(text: string, deliverAs: "steer" | "followUp") => void>();
	const abort = vi.fn<() => void>();
	const handle = await startRemoteConsole(fake.pi, {
		sendPrompt,
		abort,
		originsPath: join(tmp, "console-origins.json"),
		distDirs: [join(tmp, "absent-dist")],
		context: fakeContext(),
		...overrides,
	});
	cleanups.push(async () => {
		await handle.close();
		rmSync(tmp, { recursive: true, force: true });
	});
	return { tmp, fake, sendPrompt, abort, handle };
}

function tokenOf(handle: RemoteConsoleHandle): string {
	return new URL(handle.url).hash.slice(1);
}

function bearer(handle: RemoteConsoleHandle): Record<string, string> {
	return { authorization: `Bearer ${tokenOf(handle)}` };
}

// --- SSE reading -------------------------------------------------------------

/** One SSE frame. `payload` is the protocol event's payload from the data
 * line; `envelope` is the whole parsed data line ({v, seq, ts, type, payload}). */
interface SseFrame {
	id: number | undefined;
	type: string | undefined;
	payload: unknown;
	envelope: unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

class SseReader {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private buffer = "";

	constructor(response: Response) {
		const body = response.body;
		if (!body) throw new Error("SSE response has no body");
		this.reader = body.getReader();
	}

	/** Next protocol frame; comments and empty blocks are skipped. */
	async next(what: string): Promise<SseFrame> {
		for (;;) {
			const end = this.buffer.indexOf("\n\n");
			if (end !== -1) {
				const frame = parseFrame(this.buffer.slice(0, end));
				this.buffer = this.buffer.slice(end + 2);
				if (frame) return frame;
				continue;
			}
			const chunk = await withTimeout(this.reader.read(), 5000, what);
			if (chunk.done) throw new Error(`${what}: stream ended`);
			this.buffer += new TextDecoder().decode(chunk.value, { stream: true });
		}
	}

	async close(): Promise<void> {
		const reader = this.reader;
		try {
			await withTimeout(reader.cancel(), 2000, "SSE cancel");
		} catch {
			// Teardown races are fine; the server closes its side anyway.
		}
	}
}

function parseFrame(block: string): SseFrame | undefined {
	let id: number | undefined;
	let type: string | undefined;
	let envelope: unknown;
	let sawData = false;
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) return undefined;
		if (line.startsWith("id: ")) id = Number.parseInt(line.slice(4), 10);
		else if (line.startsWith("event: ")) type = line.slice(7);
		else if (line.startsWith("data: ")) {
			envelope = JSON.parse(line.slice(6));
			sawData = true;
		}
	}
	if (!sawData) return undefined;
	const payload = (envelope as { payload?: unknown }).payload;
	return { id, type, payload, envelope };
}

interface Connected {
	response: Response;
	reader: SseReader;
}

/** Connect to /events with the query cursor; header-based reconnects pass
 * lastEventId instead. */
async function connectStream(
	handle: RemoteConsoleHandle,
	options: { cursor?: string; lastEventId?: string } = {},
): Promise<Connected> {
	const response = await fetch(
		`${new URL(handle.url).origin}/events${options.cursor ? `?cursor=${options.cursor}` : ""}`,
		{
			headers: {
				authorization: `Bearer ${tokenOf(handle)}`,
				...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
			},
		},
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const connected: Connected = { response, reader: new SseReader(response) };
	cleanups.unshift(() => connected.reader.close());
	return connected;
}

async function postAction(
	handle: RemoteConsoleHandle,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${new URL(handle.url).origin}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${tokenOf(handle)}`, "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number | undefined; body: string }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const request = httpRequest(
			{ host: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "GET", headers },
			(response) => {
				let body = "";
				response.on("data", (chunk: Buffer) => {
					body += chunk.toString("utf8");
				});
				response.on("end", () => resolve({ status: response.statusCode, body }));
			},
		);
		request.on("error", reject);
		request.end();
	});
}

// --- replay log units --------------------------------------------------------

describe("ReplayLog", () => {
	test("assigns contiguous seqs and replays strictly after the cursor", () => {
		const log = new ReplayLog();
		const first = log.append({ v: 1, ts: "t", type: "status", payload: { status: { kind: "idle", model: null } } });
		const second = log.append({ v: 1, ts: "t", type: "ping", payload: {} });
		const third = log.append({ v: 1, ts: "t", type: "ping", payload: {} });
		expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
		expect(log.headSeq).toBe(2);
		expect(log.events_since(0)?.map((event) => event.seq)).toEqual([1, 2]);
		expect(log.events_since(2)).toEqual([]);
		// A cursor above the head (a restarted server reset the seqs) and a
		// pre-log cursor are both unusable: the caller must snapshot.
		expect(log.events_since(5)).toBeUndefined();
		expect(log.events_since(-1)).toBeUndefined();
	});

	test("drops the oldest events past the bound and marks stale cursors", () => {
		const log = new ReplayLog();
		for (let i = 0; i < 2001; i++) log.append({ v: 1, ts: "t", type: "ping", payload: {} });
		// Seqs 0..2000 were appended; the buffer retains 1..2000, so cursor 0
		// is stale and cursor 1 replays from 2.
		expect(log.events_since(0)).toBeUndefined();
		const replay = log.events_since(2);
		expect(replay).toBeDefined();
		expect(replay?.[0]?.seq).toBe(3);
		expect(log.events_since(1999)?.map((event) => event.seq)).toEqual([2000]);
	});
});

// --- boot, page, auth --------------------------------------------------------

describe("boot, page, and auth", () => {
	test("serves the built-in fallback page with hardening headers and no token material", async () => {
		const { handle } = await startTestConsole({ hostLabel: "test-host" });
		const token = tokenOf(handle);
		const response = await fetch(new URL(handle.url).origin);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("style-src 'nonce-");
		expect(csp).not.toContain("unsafe-inline");
		const page = await response.text();
		expect(page).toContain("not installed");
		expect(page).toContain(`nonce="`);
		expect(page).not.toContain(token);
	});

	test("serves the configured dist build and blocks traversal", async () => {
		const dist = mkdtempSync(join(tmpdir(), "remote-console-dist-"));
		cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
		const { handle } = await startTestConsole({ distDirs: [dist] });
		mkdirSync(join(dist, "assets"), { recursive: true });
		writeFileSync(join(dist, "assets", "app.js"), "export const build = 'console build'");
		writeFileSync(join(dist, "index.html"), '<html><script type="module" src="./assets/app.js"></script></html>');
		const page = await fetch(new URL(handle.url).origin);
		expect(await page.text()).toContain("assets/app.js");
		expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
		const asset = await fetch(`${new URL(handle.url).origin}/assets/app.js`);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toBe("text/javascript");
		expect(await asset.text()).toBe("export const build = 'console build'");
		// Traversal by encoded dot segments stays inside the dist root. A raw
		// client is required: fetch's URL parser normalizes %2e%2e to ".." and
		// would never send the dot segments.
		const base = new URL(handle.url).origin;
		expect((await rawGet(`${base}/%2e%2e/console-origins.json`, {})).status).toBe(404);
		expect((await rawGet(`${base}/assets/%2e%2e%2f%2e%2e/console-origins.json`, {})).status).toBe(404);
		// A plain missing asset is 404 too (fetch normalizes it to this path).
		expect((await fetch(`${base}/console-origins.json`)).status).toBe(404);
		const other = await fetch(new URL(handle.url).origin, { method: "PUT" });
		expect(other.status).toBe(404);
	});

	test("loopback bind names normalize to 127.0.0.1 in the URL and the snapshot origin", async () => {
		const { handle } = await startTestConsole({ host: "localhost" });
		expect(new URL(handle.url).hostname).toBe("127.0.0.1");
		// Connect through the name the server actually bound (localhost resolves
		// to either loopback family); the advertised origin is normalized.
		const response = await fetch(`http://localhost:${handle.port}/events`, {
			headers: { authorization: `Bearer ${tokenOf(handle)}` },
		});
		expect(response.status).toBe(200);
		const reader = new SseReader(response);
		const snapshot = await reader.next("loopback snapshot");
		expect((snapshot.payload as SnapshotPayload).host.origin).toBe(`http://127.0.0.1:${handle.port}`);
		await reader.close();
	});

	test("requires the bearer token from the fragment URL and shuts down", async () => {
		const { handle } = await startTestConsole();
		const base = new URL(handle.url).origin;
		expect((await fetch(`${base}/events`)).status).toBe(401);
		expect((await postAction(handle, "/prompt", { id: "x", text: "hi" }, { authorization: "" })).status).toBe(401);
		expect(
			(await postAction(handle, "/prompt", { id: "x", text: "hi" }, { authorization: `Bearer ${"0".repeat(64)}` }))
				.status,
		).toBe(401);
		// Host header is part of the perimeter: a rebinding-style host is refused.
		expect((await rawGet(`${base}/events`, { host: "attacker.example:1" })).status).toBe(403);
		expect((await postAction(handle, "/prompt", { id: "x", text: "hi" })).status).toBe(202);
		const port = handle.port;
		await handle.close();
		await expect(fetch(`http://127.0.0.1:${port}/events`)).rejects.toThrow();
	});
});

// --- SSE stream --------------------------------------------------------------

describe("SSE stream", () => {
	test("opens with a snapshot at the log head and delivers live events with seq ids", async () => {
		const { handle, fake } = await startTestConsole({ hostLabel: "test-host" });
		const connected = await connectStream(handle);
		const snapshot = await connected.reader.next("snapshot");
		expect(snapshot.id).toBe(0);
		expect(snapshot.type).toBe("snapshot");
		// The data line carries the full protocol envelope.
		expect(snapshot.envelope).toEqual({
			v: 1,
			seq: 0,
			ts: expect.any(String),
			type: "snapshot",
			payload: expect.anything(),
		});
		const payload = snapshot.payload as SnapshotPayload;
		expect(payload.protocolVersion).toBe(1);
		expect(payload.host).toEqual({
			origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
			label: "test-host",
		});
		expect(payload.status.kind).toBe("idle");
		expect(payload.sessionId).toBe("sess-test");
		expect(payload.holds).toEqual([]);
		expect(payload.queue).toEqual({ items: [], terminalQueued: 0 });

		fake.fire("message_update", {
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "He", partial: {} },
		});
		const delta = await connected.reader.next("delta");
		expect(delta.id).toBe(1);
		expect(delta.type).toBe("message_delta");
		expect(delta.payload).toEqual({ slotKey: "live-0", event: { type: "text_delta", contentIndex: 0, delta: "He" } });
		await connected.reader.close();
	});

	test("replays after a cursor and rebuilds from a snapshot when the cursor is stale", async () => {
		const { handle, fake } = await startTestConsole();
		const deltaEvent = { type: "text_delta", contentIndex: 0, delta: "x", partial: {} };
		for (let i = 0; i < 3; i++)
			fake.fire("message_update", { type: "message_update", message: {}, assistantMessageEvent: deltaEvent });
		// Query cursor replays the events after it.
		const byQuery = await connectStream(handle, { cursor: "1" });
		const replayed = [await byQuery.reader.next("replay 2"), await byQuery.reader.next("replay 3")];
		expect(replayed.map((frame) => frame.id)).toEqual([2, 3]);
		expect(replayed.every((frame) => frame.type === "message_delta")).toBe(true);
		await byQuery.reader.close();
		// Last-Event-ID header is preferred and behaves the same.
		const byHeader = await connectStream(handle, { lastEventId: "1" });
		expect((await byHeader.reader.next("header replay")).id).toBe(2);
		await byHeader.reader.close();
		// A cursor older than the buffer start gets a fresh snapshot instead.
		for (let i = 0; i < 2001; i++)
			fake.fire("message_update", { type: "message_update", message: {}, assistantMessageEvent: deltaEvent });
		const stale = await connectStream(handle, { cursor: "1" });
		const rebuilt = await stale.reader.next("stale snapshot");
		expect(rebuilt.type).toBe("snapshot");
		expect(rebuilt.id).toBeGreaterThan(0);
		expect((rebuilt.payload as SnapshotPayload).protocolVersion).toBe(1);
		await stale.reader.close();
		// A cursor inside the buffer replays exactly the remainder.
		const valid = await connectStream(handle, { cursor: String(rebuilt.id! - 1) });
		const last = await valid.reader.next("tail replay");
		expect(last.id).toBe(rebuilt.id);
		await valid.reader.close();
	});

	test("caps concurrent streams and keeps serving after disconnects", async () => {
		const { handle } = await startTestConsole();
		const connections: Connected[] = [];
		for (let i = 0; i < 4; i++) connections.push(await connectStream(handle));
		const rejected = await fetch(`${new URL(handle.url).origin}/events`, { headers: bearer(handle) });
		expect(rejected.status).toBe(503);
		for (const connected of connections) await connected.reader.close();
		const again = await connectStream(handle);
		expect((await again.reader.next("snapshot after reconnect")).type).toBe("snapshot");
		await again.reader.close();
	});
});

// --- actions -----------------------------------------------------------------

describe("actions", () => {
	test("prompt and abort dispatch with idempotent replay and conflict detection", async () => {
		const { handle, sendPrompt, abort } = await startTestConsole();
		const send = (text: string) => postAction(handle, "/prompt", { id: "one", text });
		expect((await send("hello")).status).toBe(202);
		expect(sendPrompt).toHaveBeenCalledWith("hello", "followUp");
		expect((await send("hello")).status).toBe(200);
		expect((await send("different")).status).toBe(409);
		expect(sendPrompt).toHaveBeenCalledTimes(1);
		expect((await postAction(handle, "/prompt", { id: "two", text: "now", deliverAs: "steer" })).status).toBe(202);
		expect(sendPrompt).toHaveBeenCalledWith("now", "steer");
		expect((await postAction(handle, "/abort", { id: "stop" })).status).toBe(202);
		expect(abort).toHaveBeenCalledTimes(1);
		expect((await postAction(handle, "/prompt", { id: "big", text: "x".repeat(12_001) })).status).toBe(400);
		expect((await postAction(handle, "/prompt", { id: "blank", text: "  " })).status).toBe(400);
		expect((await postAction(handle, "/prompt", { id: "bad id!", text: "hi" })).status).toBe(400);
		expect(
			(
				await fetch(`${new URL(handle.url).origin}/prompt`, {
					method: "POST",
					headers: { authorization: bearer(handle).authorization, "content-type": "text/plain" },
					body: "{}",
				})
			).status,
		).toBe(415);
		expect((await postAction(handle, "/unknown", { id: "x" })).status).toBe(404);
	});

	test("reflects registered console origins in CORS without credentials", async () => {
		const { handle } = await startTestConsole();
		const base = new URL(handle.url).origin;
		const attacker = "https://attacker.example";
		// Cross-origin requests from unregistered origins are refused outright.
		expect((await postAction(handle, "/prompt", { id: "x", text: "hi" }, { origin: attacker })).status).toBe(403);
		// Register the console origin through the authenticated settings action.
		const consoleOrigin = "https://console.example";
		expect((await postAction(handle, "/settings/console-origins", { id: "add", origin: consoleOrigin })).status).toBe(
			202,
		);
		// Preflight is unauthenticated and still reflects the registry.
		const preflight = await fetch(`${base}/prompt`, {
			method: "OPTIONS",
			headers: {
				origin: consoleOrigin,
				"access-control-request-method": "POST",
				"access-control-request-headers": "authorization",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
		expect(preflight.headers.get("vary")).toBe("Origin");
		expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
		expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
		// Unlisted origins get no allow origin at all.
		const blocked = await fetch(`${base}/prompt`, { method: "OPTIONS", headers: { origin: attacker } });
		expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
		// Registered cross-origin actual responses echo the origin too.
		const crossOriginPrompt = await postAction(
			handle,
			"/prompt",
			{ id: "cross", text: "hi" },
			{ origin: consoleOrigin },
		);
		expect(crossOriginPrompt.status).toBe(202);
		expect(crossOriginPrompt.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
		// And a cross-origin authenticated GET /events works for fleet aggregation.
		const events = await fetch(`${base}/events`, { headers: { ...bearer(handle), origin: consoleOrigin } });
		expect(events.status).toBe(200);
		expect(events.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
		const reader = new SseReader(events);
		await reader.close();
	});

	test("stores console origins atomically with owner-only permissions", async () => {
		const { handle, tmp } = await startTestConsole();
		const originsPath = join(tmp, "console-origins.json");
		expect(
			(await postAction(handle, "/settings/console-origins", { id: "a", origin: "https://console.example/" }))
				.status,
		).toBe(202);
		expect(
			(await postAction(handle, "/settings/console-origins", { id: "b", origin: "https://console.example" })).status,
		).toBe(202);
		expect((await postAction(handle, "/settings/console-origins", { id: "c", origin: "ftp://x" })).status).toBe(400);
		expect(
			(await postAction(handle, "/settings/console-origins", { id: "d", origin: "https://x/path" })).status,
		).toBe(400);
		expect((await fetch(`${new URL(handle.url).origin}/settings/console-origins`, { method: "POST" })).status).toBe(
			401,
		);
		const stored = JSON.parse(readFileSync(originsPath, "utf8")) as { origins: string[] };
		expect(stored.origins).toEqual(["https://console.example"]);
		expect(statSync(originsPath).mode & 0o777).toBe(0o600);
	});
});

// --- approvals ---------------------------------------------------------------

describe("approvals", () => {
	test("holds listed tools while a console is connected and resolves via POST", async () => {
		const { handle, fake } = await startTestConsole({ approvalTools: ["bash"] });
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");
		const handler = fake.handlers("tool_call")[0];
		const held = handler(
			{ type: "tool_call", toolName: "bash", input: { command: "ls -la" } },
			fakeContext(),
		) as Promise<unknown>;
		let settled = false;
		void held.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(settled).toBe(false);
		const approval = await connected.reader.next("approval");
		expect(approval.type).toBe("approval");
		const wire = (
			approval.payload as { holds: { id: string; toolName: string; argsPreview: string; deadlineMs: number }[] }
		).holds[0];
		if (!wire) throw new Error("approval event carried no hold");
		expect(wire.toolName).toBe("bash");
		expect(wire.argsPreview).toContain("ls -la");
		expect(wire.deadlineMs).toBeGreaterThan(Date.now());
		const resolved = await postAction(handle, "/approval", { id: wire.id, allow: true });
		expect(resolved.status).toBe(202);
		expect(await resolved.json()).toEqual({ accepted: true, resolution: "allowed" });
		expect(await held).toBeUndefined();
		// The resolution re-serves the (now empty) hold list before the done event.
		const emptied = await connected.reader.next("emptied holds");
		expect(emptied.type).toBe("approval");
		expect((emptied.payload as { holds: unknown[] }).holds).toEqual([]);
		const done = await connected.reader.next("approval done");
		expect(done.type).toBe("approval_done");
		expect(done.payload).toEqual({ id: wire.id, resolution: "allowed" });
		// Idempotent replay of the same body stays 200; a conflicting one 409.
		expect((await postAction(handle, "/approval", { id: wire.id, allow: true })).status).toBe(200);
		expect((await postAction(handle, "/approval", { id: wire.id, allow: false })).status).toBe(409);
		expect((await postAction(handle, "/approval", { id: "nope", allow: true })).status).toBe(404);
		await connected.reader.close();
	});

	test("denial blocks the tool call", async () => {
		const { handle, fake } = await startTestConsole({ approvalTools: ["bash"] });
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");
		const handler = fake.handlers("tool_call")[0];
		const held = handler(
			{ type: "tool_call", toolName: "bash", input: { command: "rm -rf build" } },
			fakeContext(),
		) as Promise<unknown>;
		const approval = await connected.reader.next("approval");
		const wire = (approval.payload as { holds: { id: string }[] }).holds[0];
		if (!wire) throw new Error("approval event carried no hold");
		await postAction(handle, "/approval", { id: wire.id, allow: false });
		const result = (await held) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("denied");
		await connected.reader.close();
	});

	test("expires holds and continues (fake timers)", async () => {
		const published: { holds?: unknown; done?: unknown }[] = [];
		const registry = new ApprovalRegistry({
			publisher: {
				pending: (holds) => published.push({ holds }),
				approvalDone: (id, resolution) => published.push({ done: { id, resolution } }),
			},
			tools: () => ["bash"],
			clientCount: () => 1,
			timeoutMs: () => 120_000,
		});
		vi.useFakeTimers();
		const held = registry.hold("bash", { command: "make deploy" });
		expect(registry.pendingAll().map((hold) => hold.toolName)).toEqual(["bash"]);
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await held).toBeUndefined();
		expect(registry.pendingAll()).toEqual([]);
		expect(published.at(-1)?.done).toEqual({
			id: (published[0]?.holds as { id: string }[])[0]?.id,
			resolution: "expired",
		});
	});

	test("serves concurrent holds as an oldest-first array on every publish", async () => {
		const { handle, fake } = await startTestConsole({ approvalTools: ["bash", "edit"] });
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");
		const handler = fake.handlers("tool_call")[0];
		const first = handler(
			{ type: "tool_call", toolName: "bash", input: { command: "one" } },
			fakeContext(),
		) as Promise<unknown>;
		const second = handler(
			{ type: "tool_call", toolName: "edit", input: { path: "two" } },
			fakeContext(),
		) as Promise<unknown>;
		const firstEvent = await connected.reader.next("first approval");
		const secondEvent = await connected.reader.next("second approval");
		expect(firstEvent.type).toBe("approval");
		expect(secondEvent.type).toBe("approval");
		const firstHolds = (firstEvent.payload as { holds: { id: string; toolName: string }[] }).holds;
		const secondHolds = (secondEvent.payload as { holds: { id: string; toolName: string }[] }).holds;
		expect(firstHolds.map((hold) => hold.toolName)).toEqual(["bash"]);
		expect(secondHolds.map((hold) => hold.toolName)).toEqual(["bash", "edit"]);
		expect(secondHolds[0]?.id).toBe(firstHolds[0]?.id);

		// A fresh connection's snapshot carries the full pending list too.
		const late = await connectStream(handle);
		const snapshot = await late.reader.next("late snapshot");
		expect((snapshot.payload as SnapshotPayload).holds.map((hold) => hold.id)).toEqual(
			secondHolds.map((hold) => hold.id),
		);
		await late.reader.close();

		// Resolving the oldest hold leaves the newer one visible and pending.
		const resolved = await postAction(handle, "/approval", { id: firstHolds[0]?.id, allow: true });
		expect(resolved.status).toBe(202);
		expect(await first).toBeUndefined();
		const remaining = await connected.reader.next("remaining holds");
		expect((remaining.payload as { holds: { id: string }[] }).holds.map((hold) => hold.id)).toEqual([
			secondHolds[1]?.id,
		]);
		const done = await connected.reader.next("approval done");
		expect(done.type).toBe("approval_done");
		expect(done.payload).toEqual({ id: firstHolds[0]?.id, resolution: "allowed" });

		// Denying the rest still blocks, and expiry still continues: the wire
		// change does not touch the resolutions.
		await postAction(handle, "/approval", { id: secondHolds[1]?.id, allow: false });
		const denied = (await second) as { block: boolean; reason: string } | undefined;
		expect(denied?.block).toBe(true);
		expect(denied?.reason).toContain("denied");
		const emptyList = await connected.reader.next("empty holds");
		expect((emptyList.payload as { holds: unknown[] }).holds).toEqual([]);
		await connected.reader.close();
	});

	test("expires holds end to end and publishes approval_done expired", async () => {
		const { handle, fake } = await startTestConsole({ approvalTools: ["bash"], approvalTimeoutMs: 60 });
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");
		const handler = fake.handlers("tool_call")[0];
		const held = handler(
			{ type: "tool_call", toolName: "bash", input: { command: "ls" } },
			fakeContext(),
		) as Promise<unknown>;
		expect((await connected.reader.next("approval")).type).toBe("approval");
		expect(await withTimeout(held, 2000, "expiry")).toBeUndefined();
		// Expiry re-serves the emptied list before the done event.
		const emptied = await connected.reader.next("emptied holds");
		expect((emptied.payload as { holds: unknown[] }).holds).toEqual([]);
		const done = await connected.reader.next("approval done");
		expect(done.type).toBe("approval_done");
		expect((done.payload as { resolution: string }).resolution).toBe("expired");
		await connected.reader.close();
	});

	test("never holds without a console, a listed tool, or the surface enabled", async () => {
		const withClient = await startTestConsole({ approvalTools: ["bash"] });
		const connected = await connectStream(withClient.handle);
		await connected.reader.next("snapshot");
		const handler = withClient.fake.handlers("tool_call")[0];
		// Unlisted tool: no hold even with a console watching.
		expect(await handler({ type: "tool_call", toolName: "read", input: {} }, fakeContext())).toBeUndefined();
		await connected.reader.close();
		// Listed tool without a connected console: no hold. The disconnect has
		// to reach the server before the call is made.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const hold = handler(
			{ type: "tool_call", toolName: "bash", input: { command: "ls" } },
			fakeContext(),
		) as Promise<unknown>;
		expect(await withTimeout(hold, 2000, "no client")).toBeUndefined();
		// Empty tool list: no hold even with a console watching.
		const withoutTools = await startTestConsole();
		const open = await connectStream(withoutTools.handle);
		await open.reader.next("snapshot");
		const emptyHandler = withoutTools.fake.handlers("tool_call")[0];
		expect(
			await emptyHandler({ type: "tool_call", toolName: "bash", input: { command: "ls" } }, fakeContext()),
		).toBeUndefined();
		await open.reader.close();
	});
});

// --- config ------------------------------------------------------------------

describe("config resolution", () => {
	test("HUMMIN_REMOTE=off disables the endpoint", () => {
		expect(resolveRemoteConsoleConfig({}, { HUMMIN_REMOTE: "off" }, "box").disabled).toBe(true);
		expect(resolveRemoteConsoleConfig({}, { HUMMIN_REMOTE: "ON" }, "box").disabled).toBe(false);
	});

	test("non-loopback binds need the settings opt-in and the env to stay on", () => {
		const lan = resolveRemoteConsoleConfig(
			{ remoteControl: { allowLan: true } },
			{ HUMMIN_REMOTE_HOST: "100.100.1.2" },
			"box",
		);
		expect(lan.host).toBe("100.100.1.2");
		expect(lan.lan).toBe(true);
		const noSetting = resolveRemoteConsoleConfig({}, { HUMMIN_REMOTE_HOST: "100.100.1.2" }, "box");
		expect(noSetting.host).toBe("127.0.0.1");
		expect(noSetting.lan).toBe(false);
		const envOff = resolveRemoteConsoleConfig(
			{ remoteControl: { allowLan: true } },
			{ HUMMIN_REMOTE_HOST: "100.100.1.2", HUMMIN_REMOTE_LAN: "off" },
			"box",
		);
		expect(envOff.host).toBe("127.0.0.1");
		const loopback = resolveRemoteConsoleConfig({}, { HUMMIN_REMOTE_HOST: "localhost" }, "box");
		expect(loopback.host).toBe("localhost");
		expect(loopback.lan).toBe(false);
	});

	test("ports, labels, and approval settings resolve env over settings", () => {
		const both = resolveRemoteConsoleConfig(
			{
				remoteControl: {
					port: 9000,
					hostLabel: "settings-label",
					approvalTools: "bash, edit",
					approvalTimeoutMs: 5000,
				},
			},
			{ HUMMIN_REMOTE_PORT: "8080" },
			"machine",
		);
		expect(both.port).toBe(8080);
		expect(both.hostLabel).toBe("settings-label");
		expect(both.approvalTools).toEqual(["bash", "edit"]);
		expect(both.approvalTimeoutMs).toBe(5000);
		const fallback = resolveRemoteConsoleConfig({}, {}, "machine");
		expect(fallback.port).toBe(0);
		expect(fallback.hostLabel).toBe("machine");
		expect(fallback.approvalTools).toEqual([]);
		expect(fallback.approvalTimeoutMs).toBe(120_000);
		const invalid = resolveRemoteConsoleConfig(
			{ remoteControl: { port: "x", approvalTools: " , bash ,, " } },
			{ HUMMIN_REMOTE_PORT: "not-a-port" },
			"m",
		);
		expect(invalid.port).toBe(0);
		expect(invalid.approvalTools).toEqual(["bash"]);
	});
});

// --- store -------------------------------------------------------------------

describe("console origins store", () => {
	test("round-trips through the atomic file and tolerates corruption", () => {
		const tmp = mkdtempSync(join(tmpdir(), "remote-console-store-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
		const path = join(tmp, "nested", "console-origins.json");
		const store = openConsoleOriginStore(path);
		expect(store.list()).toEqual([]);
		store.add("https://console.example/");
		store.add("https://peer.tailnet:4173");
		expect(store.add("https://console.example")).toEqual(["https://console.example", "https://peer.tailnet:4173"]);
		expect(() => store.add("https://x/path")).toThrow();
		const stored = JSON.parse(readFileSync(path, "utf8")) as { origins: string[] };
		expect(stored.origins).toEqual(["https://console.example", "https://peer.tailnet:4173"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		writeFileSync(path, "{not json");
		expect(openConsoleOriginStore(path).list()).toEqual([]);
	});
});

// --- event mapping -----------------------------------------------------------

describe("event mapping", () => {
	test("maps the pi event sequence to exact protocol frames", async () => {
		const { handle, fake } = await startTestConsole();
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");

		const assistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Hi" },
				{ type: "thinking", thinking: "hm" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
			stopReason: "toolUse",
		};
		const entry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-11-10T00:00:00Z",
			message: assistantMessage,
		};
		const withEntry = fakeContext({
			sessionManager: { getBranch: () => [entry], getSessionId: () => "sess-test" },
			model: { provider: "prov", id: "model-1" },
			thinkingLevel: "high",
			getContextUsage: () => ({ tokens: 1000, contextWindow: 8000, percent: 12.5 }),
		});

		fake.fire("message_start", { type: "message_start", message: assistantMessage });
		const started = await connected.reader.next("message start");
		expect(started.id).toBe(1);
		expect(started.type).toBe("message_start");
		expect(started.payload).toEqual({
			slotKey: "live-0",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				blocks: [
					{ type: "text", text: "Hi" },
					{ type: "thinking", text: "hm" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				],
			},
		});
		const update = (assistantMessageEvent: Record<string, unknown>) =>
			fake.fire("message_update", { type: "message_update", message: {}, assistantMessageEvent });
		update({ type: "text_delta", contentIndex: 0, delta: "He", partial: assistantMessage });
		expect((await connected.reader.next("text delta")).payload).toEqual({
			slotKey: "live-0",
			event: { type: "text_delta", contentIndex: 0, delta: "He" },
		});
		update({ type: "thinking_delta", contentIndex: 1, delta: "hm", partial: assistantMessage });
		expect((await connected.reader.next("thinking delta")).payload).toEqual({
			slotKey: "live-0",
			event: { type: "thinking_delta", contentIndex: 1, delta: "hm" },
		});
		update({ type: "toolcall_start", contentIndex: 2, partial: assistantMessage });
		expect((await connected.reader.next("toolcall start")).payload).toEqual({
			slotKey: "live-0",
			event: { type: "toolcall_start", contentIndex: 2 },
		});
		update({ type: "toolcall_delta", contentIndex: 2, delta: '{"comma', partial: assistantMessage });
		expect((await connected.reader.next("toolcall delta")).payload).toEqual({
			slotKey: "live-0",
			event: { type: "toolcall_delta", contentIndex: 2, delta: '{"comma' },
		});
		update({ type: "toolcall_end", contentIndex: 2, toolCall: {}, partial: assistantMessage });
		expect((await connected.reader.next("toolcall end")).payload).toEqual({
			slotKey: "live-0",
			event: { type: "toolcall_end", contentIndex: 2 },
		});
		// Unmappable variants (text_start, done) produce no frames: the next
		// frame after this fire is the message_end from the NEXT fire.
		update({ type: "text_start", contentIndex: 0, partial: assistantMessage });
		update({ type: "done", reason: "toolUse", message: assistantMessage });
		fake.fire("message_end", { type: "message_end", message: assistantMessage }, withEntry);
		const ended = await connected.reader.next("message end");
		expect(ended.id).toBe(7);
		expect(ended.type).toBe("message_end");
		expect(ended.payload).toEqual({
			slotKey: "live-0",
			entryId: "entry-1",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				blocks: [
					{ type: "text", text: "Hi" },
					{ type: "thinking", text: "hm" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				],
			},
		});

		fake.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		});
		expect((await connected.reader.next("tool start")).payload).toEqual({
			toolCallId: "t1",
			phase: "start",
			toolName: "bash",
			args: { command: "ls" },
		});
		fake.fire("tool_execution_update", {
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			partialResult: "partial out",
		});
		expect((await connected.reader.next("tool update")).payload).toEqual({
			toolCallId: "t1",
			phase: "update",
			toolName: "bash",
			partialResult: "partial out",
		});
		fake.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			durationMs: 42,
		});
		expect((await connected.reader.next("tool end")).payload).toEqual({
			toolCallId: "t1",
			phase: "end",
			toolName: "bash",
			isError: false,
			durationMs: 42,
		});

		fake.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Run?" });
		expect((await connected.reader.next("waiting status")).payload).toEqual({
			status: {
				kind: "waiting",
				detail: "Waiting in terminal: Run?",
				model: { provider: "prov", modelId: "model-1" },
				thinkingLevel: "high",
				contextUsage: { tokens: 1000, contextWindow: 8000, percent: 12.5 },
			},
		});
		fake.fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Run?" });
		expect((await connected.reader.next("idle status")).payload).toEqual({
			status: {
				kind: "idle",
				model: { provider: "prov", modelId: "model-1" },
				thinkingLevel: "high",
				contextUsage: { tokens: 1000, contextWindow: 8000, percent: 12.5 },
			},
		});
		fake.fire("session_info_changed", { type: "session_info_changed", name: "Renamed" });
		expect((await connected.reader.next("session")).payload).toEqual({
			sessionId: "sess-test",
			sessionName: "Renamed",
		});
		fake.fire(
			"agent_settled",
			{ type: "agent_settled", aborted: false },
			fakeContext({ hasPendingMessages: () => true }),
		);
		const settledStatus = await connected.reader.next("settled status");
		expect(settledStatus.type).toBe("status");
		expect((settledStatus.payload as { status: { kind: string } }).status.kind).toBe("idle");
		const settledQueue = await connected.reader.next("settled queue");
		expect(settledQueue.payload).toEqual({ queue: { items: [], terminalQueued: 1 } });
		await connected.reader.close();
	});

	test("message_end without an identity match serves an empty entryId instead of guessing", async () => {
		const { handle, fake } = await startTestConsole();
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");
		const stranger = { role: "assistant", content: [{ type: "text", text: "?" }] };
		const unrelated = {
			type: "message",
			id: "entry-9",
			parentId: null,
			timestamp: "2026-11-10T00:00:00Z",
			message: { role: "user", content: "unrelated" },
		};
		const withBranch = fakeContext({
			sessionManager: { getBranch: () => [unrelated], getSessionId: () => "sess-test" },
		});
		fake.fire("message_end", { type: "message_end", message: stranger }, withBranch);
		const ended = await connected.reader.next("message end");
		expect(ended.type).toBe("message_end");
		expect((ended.payload as { entryId: string }).entryId).toBe("");
		await connected.reader.close();
	});

	test("keeps the console-tracked queue honest through trackQueued and settle", async () => {
		const { handle, fake } = await startTestConsole();
		const connected = await connectStream(handle);
		await connected.reader.next("snapshot");
		handle.trackQueued("queued text", "steer");
		const queued = await connected.reader.next("queue");
		expect(queued.type).toBe("queue");
		const queue = (
			queued.payload as {
				queue: { items: { id: string; preview: string; deliverAs: string }[]; terminalQueued: number };
			}
		).queue;
		expect(queue.items).toHaveLength(1);
		expect(queue.items[0]?.preview).toBe("queued text");
		expect(queue.items[0]?.deliverAs).toBe("steer");
		fake.fire("agent_settled", { type: "agent_settled", aborted: false });
		// Settle publishes the idle status first, then the cleared queue.
		const settledStatus = await connected.reader.next("settled status");
		expect(settledStatus.type).toBe("status");
		const cleared = await connected.reader.next("cleared queue");
		expect(cleared.type).toBe("queue");
		expect((cleared.payload as { queue: { items: unknown[] } }).queue.items).toEqual([]);
		await connected.reader.close();
	});
});

// --- backpressure ------------------------------------------------------------

describe("backpressure", () => {
	function fakeResponse(writeReturns: boolean): ServerResponse & { writes: string[]; drain: () => void } {
		const writes: string[] = [];
		let drainHandler: (() => void) | undefined;
		const response = {
			writes,
			write: (chunk: string) => {
				writes.push(chunk);
				return writeReturns;
			},
			on: vi.fn(),
			once: (event: string, handler: () => void) => {
				if (event === "drain") drainHandler = handler;
				return response;
			},
			drain: () => drainHandler?.(),
			destroy: vi.fn(),
		};
		return response as unknown as ServerResponse & { writes: string[]; drain: () => void };
	}

	function testSource(): ConsoleEventSource {
		return new ConsoleEventSource(() => ({
			host: { origin: "http://127.0.0.1:0", label: "test" },
			protocolVersion: 1,
			sessionId: "",
			sessionName: "",
			status: { kind: "idle", model: null },
			messages: [],
			holds: [],
			queue: { items: [], terminalQueued: 0 },
		}));
	}

	test("disconnects a consumer over the queue cap without dropping events", () => {
		const source = testSource();
		// Seed the log so the opening snapshot anchors at a real head (seq 0),
		// like the production wiring does.
		source.publish("status", { status: { kind: "idle", model: null } });
		const response = fakeResponse(false);
		source.attach(response, undefined);
		for (let i = 0; i < 250; i++)
			source.publish("message_delta", {
				slotKey: "live-0",
				event: { type: "text_delta", contentIndex: 0, delta: `d${i}` },
			});
		// Over the cap: disconnect, never coalesce. Every delta stayed in the log.
		expect(response.destroy).toHaveBeenCalledTimes(1);
		expect(source.connectionCount()).toBe(0);
		// Publishing after the disconnect never touches the dead stream.
		expect(() => source.publish("status", { status: { kind: "idle", model: null } })).not.toThrow();
	});

	test("a reconnecting client with the last applied cursor receives the full stream", () => {
		const source = testSource();
		source.publish("status", { status: { kind: "idle", model: null } });
		const slow = fakeResponse(false);
		source.attach(slow, undefined);
		for (let i = 0; i < 250; i++)
			source.publish("message_delta", {
				slotKey: "live-0",
				event: { type: "text_delta", contentIndex: 0, delta: `d${i}` },
			});
		expect(slow.destroy).toHaveBeenCalledTimes(1);
		// The slow consumer had applied the seed status (seq 0) and nothing
		// else; the replay answers with every delta published since, first to
		// last - losslessness comes from the log, not from coalescing.
		const reconnected = fakeResponse(true);
		source.attach(reconnected, 0);
		expect(reconnected.writes).toHaveLength(250);
		expect(reconnected.writes[0]).toContain('"d0"');
		expect(reconnected.writes.at(-1)).toContain('"d249"');
		for (let i = 0; i < 250; i++) {
			expect(reconnected.writes.some((frame) => frame.includes(`"d${i}"`))).toBe(true);
		}
	});
});

// --- extension wrapper -------------------------------------------------------

describe("hummin-remote wrapper", () => {
	test("registers the command and reports the kill switch", async () => {
		const registerCommand = vi.fn();
		const fake = fakePi();
		const pi = { ...fake.pi, registerCommand } as unknown as ExtensionAPI;
		remoteExtension(pi);
		expect(registerCommand).toHaveBeenCalledWith("remote-control", expect.objectContaining({ category: "Session" }));
		const notify = vi.fn();
		const setStatus = vi.fn();
		const command = registerCommand.mock.calls[0]?.[1] as { handler: (args: string, ctx: unknown) => Promise<void> };
		vi.stubEnv("HUMMIN_REMOTE", "off");
		await command.handler("", {
			ui: { setStatus, notify },
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("HUMMIN_REMOTE=off"), "info");
		expect(setStatus).not.toHaveBeenCalled();
	});
});

// --- perimeter hygiene -------------------------------------------------------

describe("log hygiene", () => {
	test("the server modules never log", () => {
		const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "../extensions/lib/remote-console");
		for (const file of ["server.ts", "event-source.ts", "approvals.ts", "store.ts", "index.ts"]) {
			const source = readFileSync(join(moduleRoot, file), "utf8");
			expect(source, file).not.toMatch(/console\.(log|info|warn|error|debug)/);
			expect(source, file).not.toMatch(/process\.stdout\.write|process\.stderr\.write/);
		}
	});
});
