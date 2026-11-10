/**
 * lib/remote-console/event-source: the extension side of the console event
 * stream. Maps pi runtime events to protocol events (spec section 3.2),
 * appends them to a bounded replay log with per-host monotonic seq, and fans
 * each event out to the connected SSE streams through per-connection bounded
 * queues. Publishing is fire-and-forget: a slow or dead consumer is
 * disconnected, never awaited, so the agent loop is never blocked.
 */
import type { ServerResponse } from "node:http";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	type MessageDeltaPayload,
	PROTOCOL_VERSION,
	type RemoteEvent,
	type RemoteEventPayloadMap,
	type RemoteEventType,
	type SnapshotPayload,
	type StreamDeltaEvent,
	type ToolUpdatePayload,
	type WireStatus,
} from "./protocol.ts";

/** Newest events the log retains before the oldest are dropped. Same bound as
 * the harness mirror in packages/remote-console/src/harness/replay-log.ts. */
export const REPLAY_BUFFER_LIMIT = 2000;

/** Concurrent SSE streams per host. Action connections share the server-wide
 * socket cap (server.ts); this is the stream-only cap. */
export const MAX_STREAMS = 4;

/** Per-connection outbound queue bound. Pressure first drops superseded
 * events (coalescing), then disconnects the consumer. */
const MAX_QUEUED_EVENTS = 200;

/** Heartbeat comment period. Comments carry no id, so they never disturb
 * Last-Event-ID replay. */
const HEARTBEAT_MS = 15_000;

/** Longest tool partial result carried on the wire. */
const PREVIEW_MAX_CHARS = 2000;

/** Discriminated union form of RemoteEvent: narrows the payload by event
 * type. protocol.ts does not export this derived form; the console package
 * derives the same shape. */
type AnyRemoteEvent = { [K in RemoteEventType]: RemoteEvent<K> }[RemoteEventType];

/** Event accepted by append; the log assigns seq, so a caller-supplied one is ignored. */
type ReplayEventInput = Omit<RemoteEvent, "seq"> & { seq?: number };

/** Bounded replay buffer over protocol events with per-instance monotonic
 * seq. Semantics mirror packages/remote-console/src/harness/replay-log.ts:
 * seqs are contiguous (one per append), so the buffer's oldest seq alone
 * delimits which cursors are replayable; a cursor below it must be answered
 * with a fresh snapshot instead of a replay. */
export class ReplayLog {
	private buffer: RemoteEvent[] = [];
	private nextSeq = 0;

	/** Assigns the next seq and stores the event; returns the stored form. */
	append(event: ReplayEventInput): RemoteEvent {
		const stored: RemoteEvent = { ...event, seq: this.nextSeq };
		this.nextSeq++;
		this.buffer.push(stored);
		if (this.buffer.length > REPLAY_BUFFER_LIMIT) this.buffer.shift();
		return stored;
	}

	/** Events strictly after cursor, or undefined when cursor is older than
	 * the buffer start (the caller must send a fresh snapshot instead). */
	events_since(cursor: number): RemoteEvent[] | undefined {
		const oldest = this.buffer[0]?.seq;
		if (oldest === undefined || cursor < oldest) return undefined;
		return this.buffer.slice(cursor - oldest + 1);
	}

	/** Seq of the newest logged event, or -1 when the log is empty. A snapshot
	 * built now carries this id: reconnecting with it replays exactly the
	 * events appended after the snapshot was built. */
	get headSeq(): number {
		return this.nextSeq - 1;
	}
}

interface Connection {
	response: ServerResponse;
	queue: RemoteEvent[];
	/** A write returned false and a drain listener owns the resume. */
	draining: boolean;
	detached: boolean;
}

function frame(event: RemoteEvent): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** One SSE event fan-out plus its replay log. */
export class ConsoleEventSource {
	private log = new ReplayLog();
	private connections = new Set<Connection>();
	private snapshot: () => SnapshotPayload;
	private heartbeat: NodeJS.Timeout | undefined;

	constructor(snapshot: () => SnapshotPayload) {
		this.snapshot = snapshot;
	}

	connectionCount(): number {
		return this.connections.size;
	}

	/** Append the event to the replay log and fan it out to every connection.
	 * Synchronous and non-throwing by design: called from hot pi event paths. */
	publish<K extends RemoteEventType>(type: K, payload: RemoteEventPayloadMap[K]): void {
		// The type/payload correlation is guaranteed by the generic parameter;
		// the log's stored union cannot express it without this cast.
		const event = this.log.append({ v: PROTOCOL_VERSION, ts: new Date().toISOString(), type, payload } as ReplayEventInput);
		for (const conn of this.connections) {
			try {
				this.enqueue(conn, event);
			} catch {
				// A broken stream is cleaned up on close; never surface into the
				// publisher.
			}
		}
	}

	/** Register a response as an SSE stream and write its opening frames:
	 * replay after a valid cursor, otherwise a fresh snapshot anchored at the
	 * log head. Synchronous, so no event can slip between registration and
	 * the opening frames (no gap, no duplication). */
	attach(response: ServerResponse, cursor: number | undefined): void {
		const conn: Connection = { response, queue: [], draining: false, detached: false };
		this.connections.add(conn);
		this.updateHeartbeat();
		response.on("close", () => this.detach(conn));
		const replay = cursor === undefined ? undefined : this.log.events_since(cursor);
		if (replay) {
			for (const event of replay) response.write(frame(event));
			return;
		}
		const head = this.log.headSeq;
		response.write(
			frame({
				v: PROTOCOL_VERSION,
				seq: head,
				ts: new Date().toISOString(),
				type: "snapshot",
				payload: this.snapshot(),
			}),
		);
	}

	/** Destroy every stream and stop the heartbeat. */
	close(): void {
		for (const conn of [...this.connections]) {
			this.detach(conn);
			conn.response.destroy();
		}
	}

	private detach(conn: Connection): void {
		if (conn.detached) return;
		conn.detached = true;
		conn.queue = [];
		this.connections.delete(conn);
		this.updateHeartbeat();
	}

	private enqueue(conn: Connection, event: RemoteEvent): void {
		if (conn.detached) return;
		conn.queue.push(event);
		if (conn.queue.length > MAX_QUEUED_EVENTS && !this.coalesce(conn)) {
			// Slow consumer: still over the cap after dropping superseded
			// events. Disconnect it instead of growing memory or stalling the
			// publisher; the client reconnects and rebuilds from a snapshot.
			this.detach(conn);
			conn.response.destroy();
			return;
		}
		this.flush(conn);
	}

	/** Drop superseded events under pressure: older deltas of the same
	 * streaming slot (the newest delta carries the block forward) and older
	 * status events. True when the queue is back under the cap. */
	private coalesce(conn: Connection): boolean {
		const keep: RemoteEvent[] = [];
		const deltaSlots = new Set<string>();
		for (let i = conn.queue.length - 1; i >= 0; i--) {
			const event = conn.queue[i] as AnyRemoteEvent;
			if (event.type === "message_delta") {
				if (deltaSlots.has(event.payload.slotKey)) continue;
				deltaSlots.add(event.payload.slotKey);
			} else if (event.type === "status" && keep.some((kept) => kept.type === "status")) {
				continue;
			}
			keep.push(conn.queue[i]);
		}
		keep.reverse();
		conn.queue = keep;
		return conn.queue.length <= MAX_QUEUED_EVENTS;
	}

	private flush(conn: Connection): void {
		if (conn.draining || conn.detached) return;
		while (conn.queue.length > 0) {
			const ok = conn.response.write(frame(conn.queue.shift()!));
			if (!ok) {
				// Socket buffer full: resume when it drains.
				conn.draining = true;
				conn.response.once("drain", () => {
					conn.draining = false;
					this.flush(conn);
				});
				return;
			}
		}
	}

	private updateHeartbeat(): void {
		if (this.connections.size === 0) {
			if (this.heartbeat) {
				clearInterval(this.heartbeat);
				this.heartbeat = undefined;
			}
			return;
		}
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			for (const conn of this.connections) {
				try {
					conn.response.write(": heartbeat\n\n");
				} catch {
					// Dead socket: cleaned up by the close listener.
				}
			}
		}, HEARTBEAT_MS);
		this.heartbeat.unref();
	}
}

/** Streaming slot keys: one fresh `live-<n>` per message, so coalescing under
 * pressure is lossless at the block level. */
export class StreamSlots {
	private n = 0;

	next(): string {
		return `live-${this.n++}`;
	}
}

/** The ExtensionContext surface the status payload reads. Structural so the
 * wiring layer passes the real context and tests a partial fake. */
export interface StatusSource {
	isIdle(): boolean;
	model?: { provider: string; id: string } | undefined;
	thinkingLevel?: string | undefined;
	getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

/** Build the wire status from the live context. Fail-open: an unreadable
 * context degrades to a minimal status instead of throwing into the event
 * path. */
export function wireStatus(ctx: StatusSource | undefined, waitingTitle: string | undefined): WireStatus {
	const detail = waitingTitle ? `Waiting in terminal: ${waitingTitle}` : undefined;
	try {
		const usage = ctx?.getContextUsage?.();
		return {
			kind: waitingTitle ? "waiting" : ctx && !ctx.isIdle() ? "working" : "idle",
			...(detail ? { detail } : {}),
			model: ctx?.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : null,
			...(ctx?.thinkingLevel !== undefined ? { thinkingLevel: ctx.thinkingLevel } : {}),
			...(usage ? { contextUsage: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } } : {}),
		};
	} catch {
		return { kind: waitingTitle ? "waiting" : "idle", ...(detail ? { detail } : {}), model: null };
	}
}

/** Map a raw AssistantMessageEvent to its wire delta form. Unmappable
 * variants (start/end/done/error markers) return undefined and are not
 * published; the event's `partial` message is dropped because the console
 * tracks blocks by contentIndex, not by message snapshots. */
export function streamDeltaFromAssistantEvent(event: AssistantMessageEvent): StreamDeltaEvent | undefined {
	switch (event.type) {
		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex: event.contentIndex };
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex };
		default:
			return undefined;
	}
}

export type ToolExecutionUpdateInput =
	| { phase: "start"; toolCallId: string; toolName: string; args: unknown }
	| { phase: "update"; toolCallId: string; toolName: string; partialResult: unknown }
	| { phase: "end"; toolCallId: string; toolName: string; isError: boolean; durationMs?: number };

/** Map a tool_execution_* event to its wire form. Args and partial results
 * arrive from the runtime as untyped values (trust boundary: tool content),
 * so they are validated and bounded here. */
export function toolUpdateFromExecution(input: ToolExecutionUpdateInput): ToolUpdatePayload {
	switch (input.phase) {
		case "start": {
			const args = input.args;
			return {
				toolCallId: input.toolCallId,
				phase: "start",
				toolName: input.toolName,
				...(args !== null && typeof args === "object" && !Array.isArray(args)
					? { args: args as Record<string, unknown> }
					: {}),
			};
		}
		case "update":
			return {
				toolCallId: input.toolCallId,
				phase: "update",
				toolName: input.toolName,
				partialResult: boundedPreview(input.partialResult),
			};
		case "end":
			return {
				toolCallId: input.toolCallId,
				phase: "end",
				toolName: input.toolName,
				isError: input.isError,
				...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
			};
	}
}

/** Bounded string preview of an untyped tool value. */
export function boundedPreview(value: unknown): string {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = String(value);
		}
	}
	return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}...` : text;
}
