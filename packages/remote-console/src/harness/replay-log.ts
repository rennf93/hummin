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
	/** Extension message type for role "custom" (e.g. "hummin-memory-recall",
	 * "hummin-monitor", "hummin-task"); the console renders known types as
	 * typed notices. */
	customType?: string;
	/** Bounded, JSON-safe details of a custom message (scalars and short arrays only). */
	details?: Record<string, unknown>;
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
	stats?: WireStats;
	workspace?: WireWorkspace;
	/** Auto-compaction is enabled for this session. */
	autoCompact?: boolean;
	/** hummin version string. */
	version?: string;
}

/** Session totals as the terminal footer shows them. Every field is optional:
 * a value the extension cannot read is omitted, never guessed. */
export interface WireStats {
	/** Summed over every entry of the session file, all branches, like the terminal
	 * footer (assistant, tool, usage and compaction usage). */
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Latest assistant message: cacheRead / (input + cacheRead + cacheWrite), 0-100. */
	cacheHitPercent?: number | null;
	costUsd?: number;
	/** Output tokens per second while a message streams; null when nothing streams. */
	tokensPerSecond?: number | null;
	/** Lines added and removed by edit and write tool results, all branches. */
	diff?: { added: number; removed: number };
	/** Latest todo list on the current branch: completed items over all items. */
	todos?: { done: number; total: number };
}

export interface WireWorkspace {
	cwd: string;
	/** Repository directory name, when cwd is inside a git work tree. */
	repo?: string;
	branch?: string;
}

/** One configured local model server (hummin fleet). Read-only on the wire:
 * the console never starts, stops or reconfigures a server. */
export interface WireFleetServer {
	/** Fleet provider id: `<engine>-<host>-<port>`. */
	id: string;
	engine: string;
	host: string;
	port: number;
	/** The server's record in the fleet health file, written at discovery: "fresh"
	 * (seen within hummin's freshness window), "stale" (older), "none" (no record).
	 * This is when the server was last seen, not a live health probe. */
	discovery: "fresh" | "stale" | "none";
	models: string[];
	/** True when the session's current model is served by this server. */
	active: boolean;
}

/** A transient background activity the transcript does not carry. */
export interface WireActivity {
	kind: "compaction" | "memory_fold";
	phase: "start" | "end" | "failed";
	detail?: string;
}

/** A tool call held open by the remote approval surface. */
export interface WireApproval {
	id: string;
	toolName: string;
	argsPreview: string;
	/** Epoch ms when the hold expires and the call proceeds (fail-open by
	 * design: approvals are a convenience surface, not a security boundary). */
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
	/** Every pending hold, oldest first. */
	holds: WireApproval[];
	queue: WireQueue;
	/** Configured fleet servers; omitted when no fleet is configured. */
	fleet?: WireFleetServer[];
	/** The background activity in progress (or the last failure) at snapshot
	 * time, so a console that connects mid-activity still shows it. */
	activity?: WireActivity;
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
	/** The full pending list at publish time, oldest first: concurrent holds
	 * stay visible and the client can replace its slice wholesale. */
	holds: WireApproval[];
}

export interface ApprovalDonePayload {
	id: string;
	resolution: "allowed" | "denied" | "expired" | "terminal";
}

export interface QueuePayload {
	queue: WireQueue;
}

export interface FleetPayload {
	/** The full server list at publish time; the client replaces its slice. */
	servers: WireFleetServer[];
}

export interface ActivityPayload {
	activity: WireActivity;
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
	| "fleet"
	| "activity"
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
	fleet: FleetPayload;
	activity: ActivityPayload;
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
		// Seqs are contiguous by construction (one per append), so the window
		// [oldest, head] alone delimits which cursors are replayable.
		const stored: RemoteEvent = { ...event, seq: this.nextSeq };
		this.nextSeq++;
		this.buffer.push(stored);
		if (this.buffer.length > REPLAY_BUFFER_LIMIT) this.buffer.shift();
		return stored;
	}

	/** Events strictly after cursor, or undefined when the cursor is unusable:
	 * older than the buffer start (evicted), or above the head (a server
	 * restart resets seqs, so a high cursor names events this log never saw).
	 * Either way the caller must send a fresh snapshot instead of a replay. */
	events_since(cursor: ReplayCursor): RemoteEvent[] | undefined {
		const oldest = this.buffer[0]?.seq;
		if (oldest === undefined || cursor < oldest || cursor > this.nextSeq - 1) return undefined;
		// Contiguous seqs make the offset arithmetic exact; slice clamps past the end.
		return this.buffer.slice(cursor - oldest + 1);
	}
}
