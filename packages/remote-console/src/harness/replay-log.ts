/**
 * harness/replay-log: the replay harness's mirror of the remote console wire
 * contract (v1) plus the bounded event buffer the replay layer serves from.
 * The wire types mirror
 * packages/coding-agent/extensions/lib/remote-console/protocol.ts, which is
 * the source of truth: console and extension share fixtures, not code, so the
 * mirror is pinned by conformance tests on both sides rather than an import.
 * Pure: no I/O, no clock.
 */

/** Host identity, carried by every snapshot so a fleet-wide console can label streams. */
export interface HostIdentity {
	origin: string;
	label: string;
}

export interface WireTextBlock {
	type: "text";
	text: string;
}

export interface WireThinkingBlock {
	type: "thinking";
	text: string;
}

export interface WireToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	argumentsError?: string;
}

/** Images are never sent over the wire; the block is elided with a notice. */
export interface WireImageElidedBlock {
	type: "imageElided";
}

export type WireContentBlock = WireTextBlock | WireThinkingBlock | WireToolCallBlock | WireImageElidedBlock;

/** A message as the console renders it: AgentMessage's visible fields without provider internals. */
export interface WireAgentMessage {
	role: "user" | "assistant" | "toolResult" | "system" | "custom";
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	durationMs?: number;
	stopReason?: string;
	usage?: { input: number; output: number; total: number };
	blocks: WireContentBlock[];
}

/** One transcript entry with its stable session-entry id: the renderer's identity for
 * incremental updates and virtualization keys. */
export interface WireTranscriptEntry {
	entryId: string;
	timestamp?: string;
	message: WireAgentMessage;
}

export interface WireModelRef {
	provider: string;
	modelId: string;
}

export type RunStatusKind = "idle" | "working" | "waiting";

export interface WireStatus {
	kind: RunStatusKind;
	detail?: string;
	model: WireModelRef | null;
	thinkingLevel?: string;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** A tool call held open by the remote approval surface. */
export interface WireApproval {
	id: string;
	toolName: string;
	argsPreview: string;
	/** Epoch ms when the hold expires and the terminal takes over. */
	deadlineMs: number;
	createdAt: string;
}

export interface WireQueueItem {
	id: string;
	preview: string;
	deliverAs: "steer" | "followUp";
}

/** Console-tracked queued messages plus the honest terminal count. */
export interface WireQueue {
	items: WireQueueItem[];
	terminalQueued: number;
}

export interface SnapshotPayload {
	host: HostIdentity;
	protocolVersion: number;
	sessionId: string;
	sessionName: string;
	status: WireStatus;
	/** Branch tail in transcript order, oldest first. */
	messages: WireTranscriptEntry[];
	approval: WireApproval | null;
	queue: WireQueue;
}

export interface MessageStartPayload {
	slotKey: string;
	message: WireAgentMessage;
}

export type StreamDeltaEvent =
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number };

export interface MessageDeltaPayload {
	slotKey: string;
	event: StreamDeltaEvent;
}

export interface MessageEndPayload {
	slotKey: string;
	entryId: string;
	message: WireAgentMessage;
}

export interface ToolUpdatePayload {
	toolCallId: string;
	phase: "start" | "update" | "end";
	toolName: string;
	args?: Record<string, unknown>;
	partialResult?: string;
	isError?: boolean;
	durationMs?: number;
}

export interface StatusPayload {
	status: WireStatus;
}

export interface ApprovalPayload {
	approval: WireApproval | null;
}

export interface ApprovalDonePayload {
	id: string;
	resolution: "allowed" | "denied" | "expired" | "terminal";
}

export interface QueuePayload {
	queue: WireQueue;
}

export interface SessionPayload {
	sessionId: string;
	sessionName: string;
}

export type RemoteEventType =
	| "snapshot"
	| "message_start"
	| "message_delta"
	| "message_end"
	| "tool_update"
	| "status"
	| "approval"
	| "approval_done"
	| "queue"
	| "session"
	| "ping";

export type RemoteEventPayloadMap = {
	snapshot: SnapshotPayload;
	message_start: MessageStartPayload;
	message_delta: MessageDeltaPayload;
	message_end: MessageEndPayload;
	tool_update: ToolUpdatePayload;
	status: StatusPayload;
	approval: ApprovalPayload;
	approval_done: ApprovalDonePayload;
	queue: QueuePayload;
	session: SessionPayload;
	ping: Record<string, never>;
};

/** One protocol event on the wire. `seq` is per-host monotonic, stamped by the sender. */
export interface RemoteEvent<K extends RemoteEventType = RemoteEventType> {
	v: number;
	seq: number;
	ts: string;
	type: K;
	payload: RemoteEventPayloadMap[K];
}

/** Discriminated union form of RemoteEvent: narrows the payload by event type. */
export type AnyRemoteEvent = { [K in RemoteEventType]: RemoteEvent<K> }[RemoteEventType];

/** Newest events the log retains before the oldest are dropped. */
export const REPLAY_BUFFER_LIMIT = 2000;

/** Cursor into the log: the seq of the last event the consumer has applied. */
export type ReplayCursor = number;

/** Event accepted by append; the log assigns seq, so a caller-supplied one is ignored. */
export type ReplayEventInput = Omit<RemoteEvent, "seq"> & { seq?: number };

/** Bounded replay buffer over protocol events with per-instance monotonic seq. */
export class ReplayLog {
	private buffer: RemoteEvent[] = [];
	private nextSeq = 0;

	/** Assigns the next seq and stores the event; returns the stored form. */
	append(event: ReplayEventInput): RemoteEvent {
		// Seqs are contiguous by construction (one per append), so the buffer's
		// oldest seq alone delimits which cursors are replayable.
		const stored: RemoteEvent = { ...event, seq: this.nextSeq };
		this.nextSeq++;
		this.buffer.push(stored);
		if (this.buffer.length > REPLAY_BUFFER_LIMIT) this.buffer.shift();
		return stored;
	}

	/** Events strictly after cursor, or undefined when cursor is older than the buffer
	 * start (the caller must then send a fresh snapshot instead of a replay). */
	events_since(cursor: ReplayCursor): RemoteEvent[] | undefined {
		const oldest = this.buffer[0]?.seq;
		if (oldest === undefined || cursor < oldest) return undefined;
		// Contiguous seqs make the offset arithmetic exact; slice clamps past the end.
		return this.buffer.slice(cursor - oldest + 1);
	}
}
