/**
 * store: per-host console state as a pure reducer. One HostState per
 * registered host; a snapshot replaces the slices it carries, protocol events
 * fold incrementally (message_start opens the live slot, deltas append,
 * message_end freezes the slot into a transcript entry keyed by entryId,
 * tool_update patches the live tool map, status/queue/session/holds replace
 * their slices). Entry ids dedupe: a message_end for a non-empty entryId
 * already in the transcript is a no-op; empty entryIds always append. No
 * React, no I/O; receivedAt is an action input.
 */

import type { ConnectionState } from "./connection.ts";
import type {
	AnyRemoteEvent,
	SnapshotPayload,
	WireApproval,
	WireQueue,
	WireStatus,
	WireTranscriptEntry,
} from "./harness/replay-log.ts";
import type { ToolLiveState } from "./renderer/tool/tool-view.ts";
import { applyToolUpdate } from "./renderer/tool/tool-view.ts";
import type { LiveSlot } from "./renderer/transcript/stream-slot.ts";
import { applyStreamEvent } from "./renderer/transcript/stream-slot.ts";

export interface HostState {
	label: string;
	origin: string;
	sessionId: string | null;
	sessionName: string | null;
	status: WireStatus | null;
	/** Branch tail in transcript order, oldest first. */
	entries: WireTranscriptEntry[];
	/** The one live streaming slot, null when nothing streams. */
	slot: LiveSlot | null;
	/** tool_update phases keyed by toolCallId. */
	toolUpdates: ReadonlyMap<string, ToolLiveState>;
	/** Pending approval holds, oldest first. */
	holds: WireApproval[];
	queue: WireQueue | null;
	/** Seq of the newest applied event; reconnects resume from it. */
	lastSeq: number | null;
	/** Wall-clock ms of the newest applied event (staleness input). */
	lastSeenMs: number | null;
	connection: ConnectionState;
}

export type HostStore = Record<string, HostState>;

export type HostAction =
	| { type: "ensure"; hostId: string; label: string; origin: string }
	| { type: "event"; hostId: string; event: AnyRemoteEvent; receivedAt: number }
	| { type: "connection"; hostId: string; state: ConnectionState };

export function initialHostState(label: string, origin: string): HostState {
	return {
		label,
		origin,
		sessionId: null,
		sessionName: null,
		status: null,
		entries: [],
		slot: null,
		toolUpdates: new Map<string, ToolLiveState>(),
		holds: [],
		queue: null,
		lastSeq: null,
		lastSeenMs: null,
		connection: "connecting",
	};
}

/** Applies one action to the per-host map. Hosts materialize through "ensure"
 * (the registry is the identity source); events and connection states for
 * unknown hosts are dropped. */
export function reduceHosts(store: HostStore, action: HostAction): HostStore {
	switch (action.type) {
		case "ensure": {
			const existing = store[action.hostId];
			if (existing !== undefined) {
				if (existing.label === action.label && existing.origin === action.origin) return store;
				return { ...store, [action.hostId]: { ...existing, label: action.label, origin: action.origin } };
			}
			return { ...store, [action.hostId]: initialHostState(action.label, action.origin) };
		}
		case "connection": {
			const existing = store[action.hostId];
			if (existing === undefined) return store;
			return { ...store, [action.hostId]: { ...existing, connection: action.state } };
		}
		case "event": {
			const existing = store[action.hostId];
			if (existing === undefined) return store;
			return { ...store, [action.hostId]: applyEvent(existing, action.event, action.receivedAt) };
		}
	}
}

function applyEvent(state: HostState, event: AnyRemoteEvent, receivedAt: number): HostState {
	const seen: HostState = { ...state, lastSeq: event.seq, lastSeenMs: receivedAt };
	switch (event.type) {
		case "snapshot":
			return applySnapshot(seen, event.payload);
		case "message_start":
			return { ...seen, slot: applyStreamEvent(seen.slot, event) };
		case "message_delta":
			return applyMessageDelta(seen, event);
		case "message_end":
			return applyMessageEnd(seen, event);
		case "tool_update":
			return { ...seen, toolUpdates: applyToolUpdate(seen.toolUpdates, event.payload) };
		case "status":
			return { ...seen, status: event.payload.status };
		case "approval":
			return { ...seen, holds: [...event.payload.holds] };
		case "approval_done":
			return { ...seen, holds: seen.holds.filter((hold) => hold.id !== event.payload.id) };
		case "queue":
			return { ...seen, queue: event.payload.queue };
		case "session":
			return { ...seen, sessionId: event.payload.sessionId, sessionName: event.payload.sessionName };
		case "ping":
			return seen;
	}
}

function applySnapshot(state: HostState, payload: SnapshotPayload): HostState {
	return {
		...state,
		sessionId: payload.sessionId,
		sessionName: payload.sessionName,
		status: payload.status,
		entries: [...payload.messages],
		slot: null,
		holds: [...payload.holds],
		queue: payload.queue,
	};
}

/** Deltas without a matching open slot open an implicit one: a rebuild from a
 * snapshot (or a join mid-stream) starts after the message_start, and
 * assistant messages are the only streamed kind. */
function applyMessageDelta(state: HostState, event: Extract<AnyRemoteEvent, { type: "message_delta" }>): HostState {
	const slotKey = event.payload.slotKey;
	if (state.slot !== null && !state.slot.frozen && state.slot.slotKey === slotKey) {
		return { ...state, slot: applyStreamEvent(state.slot, event) };
	}
	const implicit: LiveSlot = { slotKey, entryId: null, frozen: false, role: "assistant", blocks: [] };
	return { ...state, slot: applyStreamEvent(implicit, event) };
}

function applyMessageEnd(state: HostState, event: Extract<AnyRemoteEvent, { type: "message_end" }>): HostState {
	const { slotKey, entryId, message } = event.payload;
	const entry: WireTranscriptEntry = { entryId, timestamp: event.ts, message };
	// Empty entry ids (identity lookup failed server-side) carry no identity to
	// dedupe against, so they always append.
	const duplicate = entryId !== "" && state.entries.some((existing) => existing.entryId === entryId);
	if (duplicate) {
		// Duplicate end (replay after reconnect): drop the matching slot, keep
		// the entry already in the transcript.
		return { ...state, slot: state.slot?.slotKey === slotKey ? null : state.slot };
	}
	const slot =
		state.slot !== null && state.slot.slotKey === slotKey ? applyStreamEvent(state.slot, event) : state.slot;
	// The frozen slot has landed as its entry; the entry is the one source now.
	return {
		...state,
		entries: [...state.entries, entry],
		slot: slot !== null && slot.slotKey === slotKey ? null : slot,
	};
}
