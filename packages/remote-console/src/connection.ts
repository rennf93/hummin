/**
 * connection: the console's client layer over fetch. Server-to-client is one
 * SSE stream per host (GET <origin>/events) read through a fetch response
 * body, because EventSource cannot send the Authorization header and the
 * token must never appear in a URL. Client-to-server actions are POSTs with
 * the same bearer header. Reconnects carry Last-Event-ID (the last seen seq)
 * with exponential backoff; a 401 stops the machine (the token is wrong and
 * the user must fix the registry entry), everything else keeps backing off.
 */
/// <reference lib="dom" />
import type { AnyRemoteEvent, RemoteEventType } from "./harness/replay-log.ts";

/** Mirrors extensions/lib/remote-console/protocol.ts PROTOCOL_VERSION; the
 * console package cannot import the extension (standalone resolution). */
const PROTOCOL_VERSION = 1;

/** Event types the wire carries (mirror of the protocol's union). */
const EVENT_TYPES: readonly RemoteEventType[] = [
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
	"fleet",
	"activity",
	"ping",
];

/** The server pings every HEARTBEAT_MS (15s, extensions/lib/remote-console/event-source.ts;
 * the console cannot import it). A stream silent for 3 heartbeats is dead
 * (half-open socket, sleeping proxy) and is recycled through the normal
 * reconnect path. */
const STALL_TIMEOUT_MS = 3 * 15_000;

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "unreachable" | "unauthorized" | "closed";

/** One dispatched SSE frame: comments are never surfaced, `event` defaults to
 * "message" per spec but the console reads the payload's own type. */
export interface SseFrame {
	id?: string;
	event?: string;
	data: string;
}

/** Incremental SSE frame parser over decoded text chunks. Partial lines carry
 * across chunks (a trailing \r is held until the next chunk, because \r\n may
 * be split); comments, multi-line data with "\n" joins, and empty-line
 * dispatches follow the SSE spec. Scanning is chunk-local: only new text is
 * searched for line breaks, so a long data line costs nothing per push. */
export class SseFrameParser {
	/** Unprocessed text after the last line terminator. */
	private carry = "";
	/** True when carry's terminator was a trailing \r held for a possible \n. */
	private heldCr = false;
	private dataLines: string[] = [];
	private eventType: string | undefined;
	private id: string | undefined;

	/** Feeds one text chunk and returns the frames it completed. */
	push(chunk: string): SseFrame[] {
		const frames: SseFrame[] = [];
		let position = 0;
		if (this.heldCr) {
			// The held \r was a terminator either way: emit its line, and when
			// this chunk opens with \n the pair consumed it.
			this.heldCr = false;
			this.emitLine(this.carry, frames);
			this.carry = "";
			if (chunk.startsWith("\n")) position = 1;
		}
		while (position < chunk.length) {
			const carriage = chunk.indexOf("\r", position);
			const newline = chunk.indexOf("\n", position);
			const index = carriage === -1 ? newline : newline === -1 ? carriage : Math.min(carriage, newline);
			if (index === -1) {
				this.carry += chunk.slice(position);
				break;
			}
			if (chunk[index] === "\r" && index === chunk.length - 1) {
				// \r\n may be split across chunks: hold the \r, keep the line open.
				this.carry += chunk.slice(position, index);
				this.heldCr = true;
				break;
			}
			this.emitLine(this.carry + chunk.slice(position, index), frames);
			this.carry = "";
			position = chunk[index] === "\r" && chunk[index + 1] === "\n" ? index + 2 : index + 1;
		}
		return frames;
	}

	/** Dispatches whatever a stream ending without a final newline leaves: the
	 * carried line (its held \r still terminates it), then the pending frame. */
	flush(): SseFrame[] {
		const frames: SseFrame[] = [];
		const remaining = this.carry;
		const held = this.heldCr;
		this.carry = "";
		this.heldCr = false;
		if (remaining !== "" || held) this.emitLine(remaining, frames);
		const frame = this.dispatch();
		if (frame !== null) frames.push(frame);
		return frames;
	}

	/** Processes one line: empty lines dispatch, comments vanish, fields set
	 * the frame being built. */
	private emitLine(line: string, frames: SseFrame[]): void {
		if (line === "") {
			const frame = this.dispatch();
			if (frame !== null) frames.push(frame);
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			this.dataLines.push(value);
		} else if (field === "event") {
			this.eventType = value;
		} else if (field === "id" && !value.includes("\0")) {
			this.id = value;
		}
	}

	private dispatch(): SseFrame | null {
		if (this.dataLines.length === 0) {
			this.eventType = undefined;
			return null;
		}
		const frame: SseFrame = { data: this.dataLines.join("\n") };
		if (this.eventType !== undefined) frame.event = this.eventType;
		if (this.id !== undefined) frame.id = this.id;
		this.dataLines = [];
		this.eventType = undefined;
		return frame;
	}
}

export interface SseConnectionOptions {
	origin: string;
	token: string;
	onFrame(frame: SseFrame): void;
	onState(state: ConnectionState): void;
	/** Test seam; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	/** Backoff base and cap in ms (250ms base, 8s cap by default). */
	backoffBaseMs?: number;
	backoffCapMs?: number;
}

export interface SseConnection {
	getState(): ConnectionState;
	/** Seq of the last frame that carried an id; reconnects send it as Last-Event-ID. */
	getLastId(): string;
	/** Stops the machine permanently: aborts the in-flight fetch and clears timers. */
	close(): void;
}

/** Base URL without trailing slashes. */
function trimOrigin(origin: string): string {
	return origin.replace(/\/+$/, "");
}

export function connectSse(options: SseConnectionOptions): SseConnection {
	const doFetch = options.fetchImpl ?? fetch;
	const baseMs = options.backoffBaseMs ?? 250;
	const capMs = options.backoffCapMs ?? 8000;
	const eventsUrl = `${trimOrigin(options.origin)}/events`;
	let state: ConnectionState = "connecting";
	let lastId = "";
	let failures = 0;
	let attemptsStarted = 0;
	let disposed = false;
	let abort: AbortController | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watchdog: ReturnType<typeof setTimeout> | null = null;

	function clearWatchdog(): void {
		if (watchdog !== null) clearTimeout(watchdog);
		watchdog = null;
	}

	function setState(next: ConnectionState): void {
		if (state === next) return;
		state = next;
		options.onState(next);
	}

	// The initial state is notified synchronously so callers can render it.
	options.onState("connecting");

	function scheduleRetry(): void {
		if (disposed || timer !== null) return;
		// failures was already reset to 0 when a stream was accepted, so the
		// backoff doubles per consecutive missed attempt and resets on success.
		const delay = Math.min(capMs, baseMs * 2 ** failures);
		failures++;
		timer = setTimeout(() => {
			timer = null;
			void attempt();
		}, delay);
	}

	async function attempt(): Promise<void> {
		if (disposed) return;
		// The very first attempt reports "connecting"; everything after a drop
		// reports "reconnecting", even after the backoff reset.
		const firstAttempt = attemptsStarted === 0;
		attemptsStarted++;
		setState(firstAttempt ? "connecting" : "reconnecting");
		const controller = new AbortController();
		abort = controller;
		let stalled = false;
		/** Re-armed on every received chunk; firing aborts the silent stream. */
		const armWatchdog = (): void => {
			clearWatchdog();
			watchdog = setTimeout(() => {
				stalled = true;
				controller.abort();
			}, STALL_TIMEOUT_MS);
		};
		const headers: Record<string, string> = {
			accept: "text/event-stream",
			authorization: `Bearer ${options.token}`,
		};
		if (lastId !== "") headers["last-event-id"] = lastId;
		try {
			const response = await doFetch(eventsUrl, { headers, signal: controller.signal });
			if (disposed) return;
			if (response.status === 401) {
				// The token is wrong: hot-reconnecting cannot fix it.
				setState("unauthorized");
				return;
			}
			if (!response.ok || response.body === null) {
				setState("unreachable");
				scheduleRetry();
				return;
			}
			failures = 0;
			setState("connected");
			armWatchdog();
			await consumeStream(
				response.body,
				(frame) => {
					if (frame.id !== undefined) lastId = frame.id;
					options.onFrame(frame);
				},
				{ signal: controller.signal, onChunk: armWatchdog },
			);
			clearWatchdog();
			if (disposed) return;
			setState("reconnecting");
			scheduleRetry();
		} catch {
			clearWatchdog();
			if (disposed) return;
			setState(stalled ? "reconnecting" : "unreachable");
			scheduleRetry();
		}
	}

	void attempt();

	return {
		getState: () => state,
		getLastId: () => lastId,
		close: () => {
			disposed = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			clearWatchdog();
			abort?.abort();
			setState("closed");
		},
	};
}

/** Reads an SSE body to its end, dispatching frames. Returns when the server
 * closes the stream; the caller decides what reconnecting means. */
export async function consumeStream(
	body: ReadableStream<Uint8Array>,
	onFrame: (frame: SseFrame) => void,
	hooks: { signal?: AbortSignal; onChunk?: () => void } = {},
): Promise<void> {
	const parser = new SseFrameParser();
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let first = true;
	// Real fetch bodies error on abort; a cancel also ends bodies that do not.
	const cancel = (): void => void reader.cancel().catch(() => undefined);
	hooks.signal?.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			hooks.onChunk?.();
			let text = decoder.decode(value, { stream: true });
			if (first) {
				text = text.replace(/^\uFEFF/, "");
				first = false;
			}
			for (const frame of parser.push(text)) onFrame(frame);
		}
		for (const frame of parser.flush()) onFrame(frame);
	} finally {
		hooks.signal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** Parses an SSE frame's data into a protocol event. Wire input is a trust
 * boundary: the envelope is validated (version, seq, type, payload presence)
 * and the payload shape is trusted to the protocol contract, which the
 * renderer narrows defensively. Returns null for anything malformed. */
export function parseProtocolEvent(frame: SseFrame): AnyRemoteEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame.data);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as { v?: unknown; seq?: unknown; type?: unknown; payload?: unknown };
	if (record.v !== PROTOCOL_VERSION) return null;
	if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq)) return null;
	if (typeof record.type !== "string" || !EVENT_TYPES.includes(record.type as RemoteEventType)) return null;
	if (typeof record.payload !== "object" || record.payload === null) return null;
	// The type/payload correlation holds because `type` passed the union check.
	return parsed as AnyRemoteEvent;
}

export interface ActionResult {
	ok: boolean;
	/** HTTP status; 0 when the fetch itself failed. */
	status: number;
}

/** Inline failure text for a rejected action (status 0 is a failed fetch). */
export function describeSendFailure(result: ActionResult): string {
	if (result.status === 0) return "Not sent: host unreachable";
	if (result.status === 401) return "Not sent: unauthorized (status 401)";
	return `Not sent: status ${result.status}`;
}

async function postAction(input: {
	origin: string;
	token: string;
	path: string;
	body: unknown;
	fetchImpl?: typeof fetch;
}): Promise<ActionResult> {
	const doFetch = input.fetchImpl ?? fetch;
	try {
		const response = await doFetch(`${trimOrigin(input.origin)}${input.path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
			body: JSON.stringify(input.body),
		});
		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}

/** Sends a prompt: {id, text, deliverAs} to POST /prompt. */
export function postPrompt(input: {
	origin: string;
	token: string;
	id: string;
	text: string;
	deliverAs: "steer" | "followUp";
	fetchImpl?: typeof fetch;
}): Promise<ActionResult> {
	return postAction({
		origin: input.origin,
		token: input.token,
		path: "/prompt",
		body: { id: input.id, text: input.text, deliverAs: input.deliverAs },
		fetchImpl: input.fetchImpl,
	});
}

/** Sends an abort: {id} to POST /abort. */
export function postAbort(input: {
	origin: string;
	token: string;
	id: string;
	fetchImpl?: typeof fetch;
}): Promise<ActionResult> {
	return postAction({
		origin: input.origin,
		token: input.token,
		path: "/abort",
		body: { id: input.id },
		fetchImpl: input.fetchImpl,
	});
}

/** Resolves an approval hold: {id, allow} to POST /approval. */
export function postApproval(input: {
	origin: string;
	token: string;
	id: string;
	allow: boolean;
	fetchImpl?: typeof fetch;
}): Promise<ActionResult> {
	return postAction({
		origin: input.origin,
		token: input.token,
		path: "/approval",
		body: { id: input.id, allow: input.allow },
		fetchImpl: input.fetchImpl,
	});
}

/** Registers this console page's origin on a host so the host's CORS
 * allowlist admits the page for cross-origin fleet aggregation: {id, origin}
 * to POST /settings/console-origins, authenticated with the host's own
 * (pasted) token. */
export function postConsoleOrigin(input: {
	origin: string;
	token: string;
	consoleOrigin: string;
	fetchImpl?: typeof fetch;
}): Promise<ActionResult> {
	return postAction({
		origin: input.origin,
		token: input.token,
		path: "/settings/console-origins",
		body: { id: crypto.randomUUID(), origin: input.consoleOrigin },
		fetchImpl: input.fetchImpl,
	});
}
