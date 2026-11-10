/**
 * lib/remote-console/protocol: the wire contract (v1) between the hummin
 * extension's control server and the browser console. The extension side is
 * the source of truth for these types; the console package mirrors them and
 * a conformance test pins the mirror (client and server share fixtures, not
 * code, because the extension must resolve without a workspace import when
 * synced to ~/.hummin/agent/extensions).
 *
 * Transport: one SSE stream per host connection carries RemoteEvents with
 * per-host monotonic `seq`. The server keeps a bounded replay buffer and
 * resumes from the SSE Last-Event-ID header; a cursor older than the buffer
 * replays a fresh `snapshot` instead, so the client never errors on a stale
 * cursor. Actions (prompt, abort, approval, settings) are POSTs and stay out
 * of this module. Deltas of the same streaming slot may be coalesced by the
 * server under backpressure; `slotKey` exists so coalescing is lossless at
 * the block level.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const PROTOCOL_VERSION = 1;

/** Host identity, carried by every snapshot so a fleet-wide console can
 * label streams. `origin` is the base URL the stream was fetched from. */
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

/** A message as the console renders it. Mirrors AgentMessage's visible
 * fields (packages/agent/src/types.ts) without provider internals. */
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

/** One transcript entry with its stable session-entry id: the renderer's
 * identity for incremental updates and virtualization keys. */
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
	/** Human detail, e.g. "Waiting in terminal: confirm dialog title". */
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

/** Console-tracked queued messages plus the honest terminal count (the
 * extension cannot read terminal-typed queue contents). */
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

export interface RemoteEvent<K extends RemoteEventType = RemoteEventType> {
	v: number;
	seq: number;
	ts: string;
	type: K;
	payload: RemoteEventPayloadMap[K];
}

/** Convert a session entry message to its wire form; images are elided, not
 * transported. Extension-side helper shared by the snapshot builder. */
export function toWireMessage(message: AgentMessage): WireAgentMessage {
	const blocks: WireContentBlock[] = [];
	if ("content" in message) {
		if (typeof message.content === "string") {
			blocks.push({ type: "text", text: message.content });
		} else {
			for (const block of message.content) {
				if (block.type === "text") blocks.push({ type: "text", text: block.text ?? "" });
				else if (block.type === "thinking") blocks.push({ type: "thinking", text: block.thinking ?? "" });
				else if (block.type === "toolCall")
					blocks.push({
						type: "toolCall",
						id: block.id,
						name: block.name,
						arguments: (block.arguments ?? {}) as Record<string, unknown>,
						...(block.argumentsError ? { argumentsError: block.argumentsError } : {}),
					});
				else if (block.type === "image") blocks.push({ type: "imageElided" });
			}
		}
	}
	const usage = (message as { usage?: { input?: number; output?: number; total?: number } }).usage;
	const wire: WireAgentMessage = {
		// Custom message types (bashExecution, branchSummary, compactionSummary,
		// extension-registered ones) carry their type as the role. The wire union
		// names the roles the console renders; unknown custom roles flow through
		// as their string so no transcript entry is dropped.
		role: message.role as WireAgentMessage["role"],
		blocks,
	};
	const m = message as {
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		durationMs?: number;
		stopReason?: string;
	};
	if (m.toolCallId !== undefined) wire.toolCallId = m.toolCallId;
	if (m.toolName !== undefined) wire.toolName = m.toolName;
	if (m.isError !== undefined) wire.isError = m.isError;
	if (m.durationMs !== undefined) wire.durationMs = m.durationMs;
	if (m.stopReason !== undefined) wire.stopReason = m.stopReason;
	if (usage && typeof usage.input === "number" && typeof usage.output === "number") {
		wire.usage = { input: usage.input, output: usage.output, total: usage.total ?? usage.input + usage.output };
	}
	return wire;
}
