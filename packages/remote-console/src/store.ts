/**
 * store: per-host console state as a pure reducer. One HostState per
 * registered host; a snapshot replaces the slices it carries, protocol events
 * fold incrementally (message_start opens the live slot, deltas append,
 * message_end freezes the slot into a transcript entry keyed by entryId,
 * tool_update patches the live tool map, status/queue/session/holds/fleet
 * replace their slices; activity is set on start, cleared by the end of the same kind, and a
 * failure stays visible until a new activity starts or the run resumes
 * working). Entry ids dedupe: a message_end for a non-empty entryId
 * already in the transcript is a no-op; empty entryIds always append. No
 * React, no I/O; receivedAt is an action input.
 */

import type { ConnectionState } from "./connection.ts";
import type {
	AnyRemoteEvent,
	SnapshotPayload,
	WireActivity,
	WireApproval,
	WireFleetServer,
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
	/** Newest numeric tok/s seen; the server sends null between replies. */
	lastTokensPerSecond: number | null;
	/** Branch tail in transcript order, oldest first. */
	entries: WireTranscriptEntry[];
	/** The one live streaming slot, null when nothing streams. */
	slot: LiveSlot | null;
	/** tool_update phases keyed by toolCallId. */
	toolUpdates: ReadonlyMap<string, ToolLiveState>;
	/** Pending approval holds, oldest first. */
	holds: WireApproval[];
	queue: WireQueue | null;
	/** Configured model servers, read-only; empty when the host publishes none. */
	fleet: WireFleetServer[];
	/** Background activity (compaction, memory fold); a failed one lingers. */
	activity: WireActivity | null;
	/** Seq of the newest applied event; reconnects resume from it. */
	lastSeq: number | null;
	/** Wall-clock ms of the newest applied event (staleness input). */
	lastSeenMs: number | null;
	/** Browser receive time minus the event's host `ts`; hold deadlines are host-clock. */
	clockOffsetMs: number;
	connection: ConnectionState;
}

export type HostStore = Record<string, HostState>;

export type HostAction =
	| { type: "ensure"; hostId: string; label: string; origin: string }
	| { type: "event"; hostId: string; event: AnyRemoteEvent; receivedAt: number }
	| { type: "connection"; hostId: string; state: ConnectionState }
	/** Drops a removed host's state. */
	| { type: "forget"; hostId: string };

export function initialHostState(label: string, origin: string): HostState {
	return {
		label,
		origin,
		sessionId: null,
		sessionName: null,
		status: null,
		lastTokensPerSecond: null,
		entries: [],
		slot: null,
		toolUpdates: new Map<string, ToolLiveState>(),
		holds: [],
		queue: null,
		fleet: [],
		activity: null,
		lastSeq: null,
		lastSeenMs: null,
		clockOffsetMs: 0,
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
		case "forget": {
			if (store[action.hostId] === undefined) return store;
			const { [action.hostId]: _dropped, ...rest } = store;
			return rest;
		}
		case "event": {
			const existing = store[action.hostId];
			if (existing === undefined) return store;
			try {
				return { ...store, [action.hostId]: applyEvent(existing, action.event, action.receivedAt) };
			} catch {
				// A malformed payload must not crash the app: keep the state, remember the seq.
				return { ...store, [action.hostId]: { ...existing, lastSeq: action.event.seq } };
			}
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Minimal shape check of the payloads the reducer dereferences first; the
 * envelope is validated by the parser, the rest is trusted or caught. */
function assertApplicable(event: AnyRemoteEvent): void {
	const payload: unknown = event.payload;
	if (event.type === "snapshot") {
		if (!isRecord(payload) || !Array.isArray(payload.messages) || !isRecord(payload.status))
			throw new Error("malformed snapshot");
	} else if (event.type === "status") {
		if (!isRecord(payload) || !isRecord(payload.status)) throw new Error("malformed status");
	}
}

function applyEvent(state: HostState, event: AnyRemoteEvent, receivedAt: number): HostState {
	assertApplicable(event);
	const sentMs = Date.parse(event.ts);
	const seen: HostState = {
		...state,
		lastSeq: event.seq,
		lastSeenMs: receivedAt,
		clockOffsetMs: Number.isFinite(sentMs) ? receivedAt - sentMs : state.clockOffsetMs,
	};
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
		case "status": {
			const resumed = event.payload.status.kind === "working" && seen.activity?.phase === "failed";
			return {
				...seen,
				status: event.payload.status,
				lastTokensPerSecond: rememberTokensPerSecond(seen.lastTokensPerSecond, event.payload.status),
				activity: resumed ? null : seen.activity,
			};
		}
		case "fleet":
			return { ...seen, fleet: [...event.payload.servers] };
		case "activity":
			// An "end" closes only its own kind: a stale end must not hide a newer activity.
			if (event.payload.activity.phase === "end") {
				return { ...seen, activity: seen.activity?.kind === event.payload.activity.kind ? null : seen.activity };
			}
			return { ...seen, activity: event.payload.activity };
		case "approval":
			return { ...seen, holds: [...event.payload.holds] };
		case "approval_done":
			return { ...seen, holds: seen.holds.filter((hold) => hold.id !== event.payload.id) };
		case "queue":
			return { ...seen, queue: event.payload.queue };
		case "session": {
			const changed = event.payload.sessionId !== seen.sessionId;
			return {
				...seen,
				sessionId: event.payload.sessionId,
				sessionName: event.payload.sessionName,
				lastTokensPerSecond: changed ? null : seen.lastTokensPerSecond,
				activity: changed ? null : seen.activity,
			};
		}
		case "ping":
			return seen;
	}
}

function rememberTokensPerSecond(last: number | null, status: WireStatus | null): number | null {
	const live = status?.stats?.tokensPerSecond;
	return typeof live === "number" ? live : last;
}

function applySnapshot(state: HostState, payload: SnapshotPayload): HostState {
	const carried = payload.sessionId === state.sessionId ? state.lastTokensPerSecond : null;
	return {
		...state,
		lastTokensPerSecond: rememberTokensPerSecond(carried, payload.status),
		sessionId: payload.sessionId,
		sessionName: payload.sessionName,
		status: payload.status,
		entries: [...payload.messages],
		slot: null,
		toolUpdates: new Map<string, ToolLiveState>(),
		holds: [...payload.holds],
		queue: payload.queue,
		fleet: [...(payload.fleet ?? [])],
		activity: payload.activity ?? null,
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
