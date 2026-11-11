/**
 * renderer/transcript/TranscriptList: renders WireTranscriptEntry[] as the transcript
 * reading column. Rows use content-visibility: auto (renderer.css) with stable entryId
 * keys (a position key when an older server sends an empty id); happy-dom does not implement content-visibility, so tests observe every row in
 * the DOM and the real render-skipping behavior is verified under Playwright. A
 * toolResult whose call is rendered in the entries is hidden (its tool row shows the
 * result); orphans still render. Adjacent identical notices render as one row with a
 * repeat count (the first entry's key and id; the duplicates never reach the DOM). Follow-bottom activates within 96px of the bottom and
 * keeps pinning as content height changes (ResizeObserver), and a snapshot that
 * replaces the list pins to the bottom. A reader who scrolled up is never moved. The
 * live streaming slot renders below the entries, deduplicated against a frozen entry
 * that has landed; a working indicator fills the gap before its first visible content.
 */
/// <reference lib="dom" />
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnectionState } from "../../connection.ts";
import type { WireTranscriptEntry } from "../../harness/replay-log.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Shimmer } from "../../ui/Shimmer.tsx";
import { StatusDot } from "../../ui/StatusDot.tsx";
import { usePresence } from "../../ui/usePresence.ts";
import type { ToolLiveState, ToolResultView } from "../tool/tool-view.ts";
import { collectToolCallIds, collectToolResults } from "../tool/tool-view.ts";
import { EntryRow, SlotRow } from "./EntryRow.tsx";
import { isNearBottom } from "./follow-bottom.ts";
import { noticeSignature } from "./notice.ts";
import type { LiveSlot } from "./stream-slot.ts";
import "../renderer.css";

/** An entry with its render key: the entryId, or a position key when an older server sent "". */
interface KeyedEntry {
	entry: WireTranscriptEntry;
	key: string;
}

function keyEntries(entries: readonly WireTranscriptEntry[]): KeyedEntry[] {
	return entries.map((entry, index) => ({ entry, key: entry.entryId !== "" ? entry.entryId : `pos:${index}` }));
}

/**
 * Arrival tracking for the entrance animation (renderer.css reads
 * data-rc-arrived). Entries present at the first render - or in a wholesale
 * replacement (the previous list was non-empty and shares no key with the new one,
 * as in a host switch or replay reset; or an empty list that fills with several
 * entries at once, which is a snapshot) render static; keys first seen after that
 * baseline are stamped data-rc-arrived and animate, so the first live message in an
 * empty transcript does enter. `replaced` reports the wholesale case so the list can
 * pin to the bottom. Render-phase memoization against the entries reference keeps
 * the result stable across re-renders of the same list.
 */
function useArrivals(
	entries: readonly WireTranscriptEntry[],
	keyed: readonly KeyedEntry[],
): { arrived: ReadonlySet<string>; replaced: boolean } {
	const seenRef = useRef<ReadonlySet<string> | null>(null);
	const lastRef = useRef<{ entries: readonly WireTranscriptEntry[]; arrived: ReadonlySet<string>; replaced: boolean } | null>(
		null,
	);
	if (lastRef.current !== null && lastRef.current.entries === entries) return lastRef.current;
	const seen = seenRef.current;
	const keys = keyed.map((item) => item.key);
	let arrived: ReadonlySet<string>;
	let replaced = false;
	const snapshotIntoEmpty = seen !== null && seen.size === 0 && keys.length > 1;
	const disjoint = seen !== null && seen.size > 0 && keys.length > 0 && keys.every((key) => !seen.has(key));
	if (seen === null || snapshotIntoEmpty || disjoint) {
		seenRef.current = new Set(keys);
		arrived = new Set();
		replaced = true;
	} else {
		const fresh = keys.filter((key) => !seen.has(key));
		seenRef.current = new Set([...seen, ...fresh]);
		arrived = new Set(fresh);
	}
	lastRef.current = { entries, arrived, replaced };
	return lastRef.current;
}

/**
 * Handover tracking. The store nulls the live slot and appends its entry in one step, so
 * the list sees an unfrozen slot vanish while a fresh entry of the same role appears (or a
 * frozen slot whose entryId has landed). That entry keeps rendering through SlotRow under
 * the slot's key, so mounted state (expanded tools, open thinking) survives and the entry
 * is not treated as an arrival. Returns render key -> slotKey for landed entries; keys
 * that left the list are pruned so the map never outgrows it.
 */
function useLandedSlots(keyed: readonly KeyedEntry[], slot: LiveSlot | null | undefined): ReadonlyMap<string, string> {
	const landed = useRef(new Map<string, string>());
	const live = useRef<{ slotKey: string; role: string } | null>(null);
	const known = useRef<ReadonlySet<string>>(new Set());
	const handled = useRef<readonly KeyedEntry[] | null>(null);
	if (handled.current !== keyed) {
		handled.current = keyed;
		const previous = live.current;
		if (previous !== null && (slot === undefined || slot === null || slot.slotKey !== previous.slotKey)) {
			const fresh = keyed.find((candidate) => !known.current.has(candidate.key) && candidate.entry.message.role === previous.role);
			if (fresh !== undefined) landed.current.set(fresh.key, previous.slotKey);
		}
		known.current = new Set(keyed.map((item) => item.key));
		for (const key of landed.current.keys()) if (!known.current.has(key)) landed.current.delete(key);
	}
	// "" is no id: an older server's empty entryId never matches an entry
	if (slot !== undefined && slot !== null && slot.frozen && slot.entryId !== null && slot.entryId !== "" && known.current.has(slot.entryId)) {
		landed.current.set(slot.entryId, slot.slotKey);
	}
	live.current = slot !== undefined && slot !== null && !slot.frozen ? { slotKey: slot.slotKey, role: slot.role } : null;
	return landed.current;
}

const landedSlots = new WeakMap<WireTranscriptEntry, LiveSlot>();

/** A landed entry as a frozen slot, cached per entry object so SlotRow's memo holds. */
function landedSlot(entry: WireTranscriptEntry, slotKey: string): LiveSlot {
	let slot = landedSlots.get(entry);
	if (slot === undefined) {
		slot = {
			slotKey,
			entryId: entry.entryId,
			frozen: true,
			role: entry.message.role,
			customType: entry.message.customType,
			details: entry.message.details,
			blocks: entry.message.blocks,
			durationMs: entry.message.durationMs,
			usage: entry.message.usage,
		};
		landedSlots.set(entry, slot);
	}
	return slot;
}

/** True once the slot would paint something: text, thinking, a tool call or an image note. */
function slotHasContent(slot: LiveSlot): boolean {
	return slot.blocks.some((block) =>
		block.type === "text" || block.type === "thinking" ? block.text !== "" : true,
	);
}

interface RowGroup {
	entry: WireTranscriptEntry;
	key: string;
	/** Run length when more than one identical notice collapsed into this row. */
	repeat?: number;
}

/** Collapses runs of adjacent identical notices into their first entry plus a count. */
function groupRepeatedNotices(entries: readonly KeyedEntry[]): RowGroup[] {
	const groups: RowGroup[] = [];
	let lastSignature: string | undefined;
	for (const { entry, key } of entries) {
		const signature = noticeSignature(entry.message);
		const last = groups[groups.length - 1];
		if (signature !== undefined && signature === lastSignature && last !== undefined) {
			last.repeat = (last.repeat ?? 1) + 1;
		} else {
			groups.push({ entry, key });
		}
		lastSignature = signature;
	}
	return groups;
}

/** The slice of `source` that `ids` read. Reuses `cached` when every id still maps to the same
 * value object, so a row whose own tool calls did not change keeps stable props and its memo holds. */
function narrowToIds<T>(
	ids: readonly string[],
	source: ReadonlyMap<string, T> | undefined,
	cached: ReadonlyMap<string, T> | undefined,
): ReadonlyMap<string, T> | undefined {
	const picked: [string, T][] = [];
	for (const id of ids) {
		const value = source?.get(id);
		if (value !== undefined) picked.push([id, value]);
	}
	if (picked.length === 0) return undefined;
	const unchanged =
		cached !== undefined && cached.size === picked.length && picked.every(([id, value]) => cached.get(id) === value);
	return unchanged ? cached : new Map(picked);
}

interface RowToolMaps {
	results?: ReadonlyMap<string, ToolResultView>;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
}

function toolCallIdsOf(blocks: readonly { type: string; id?: string }[]): string[] {
	const ids: string[] = [];
	for (const block of blocks) if (block.type === "toolCall" && block.id !== undefined) ids.push(block.id);
	return ids;
}

/** Quiet messages for a host that is not loading and has nothing to show. */
const EMPTY_STATE_MESSAGES: Partial<Record<ConnectionState, string>> = {
	unauthorized: "Not authorized. Reopen the /remote-control URL to reconnect.",
	unreachable: "Host unreachable. Retrying.",
	closed: "Disconnected.",
};

export function TranscriptList({
	entries,
	slot,
	toolUpdates,
	working = false,
	connection,
	snapshotReceived = false,
}: {
	entries: readonly WireTranscriptEntry[];
	slot?: LiveSlot | null;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
	/** The agent is running a turn: drives the working indicator (DESIGN.md motion 2). */
	working?: boolean;
	/** The host's connection state: picks the empty state. Omitted keeps the loading skeleton. */
	connection?: ConnectionState;
	/** A snapshot has landed: a connected host with no entries is then genuinely empty. */
	snapshotReceived?: boolean;
}) {
	const results = useMemo(() => collectToolResults(entries), [entries]);
	const keyed = useMemo(() => keyEntries(entries), [entries]);
	const visibleEntries = useMemo(() => {
		const callIds = collectToolCallIds(entries);
		return keyed.filter(({ entry }) => {
			const message = entry.message;
			return !(message.role === "toolResult" && message.toolCallId !== undefined && callIds.has(message.toolCallId));
		});
	}, [entries, keyed]);
	const rows = useMemo(() => groupRepeatedNotices(visibleEntries), [visibleEntries]);
	const { arrived, replaced } = useArrivals(entries, keyed);
	const landed = useLandedSlots(keyed, slot);
	// "" is never a known id: only a real entryId can dedupe the frozen slot against its landed entry
	const entryIds = useMemo(() => new Set(entries.filter((entry) => entry.entryId !== "").map((entry) => entry.entryId)), [entries]);
	// Each row reads only its own tool calls' results and live phases, kept referentially
	// stable across renders, so one tool_update re-renders one row instead of every tool row.
	const toolMapsRef = useRef(new Map<string, RowToolMaps>());
	const nextToolMaps = new Map<string, RowToolMaps>();
	const toolMapsFor = (rowKey: string, blocks: readonly { type: string; id?: string }[]): RowToolMaps => {
		const ids = toolCallIdsOf(blocks);
		if (ids.length === 0) return {};
		const cached = toolMapsRef.current.get(rowKey);
		const maps = {
			results: narrowToIds(ids, results, cached?.results),
			toolUpdates: narrowToIds(ids, toolUpdates, cached?.toolUpdates),
		};
		const reuse = cached !== undefined && cached.results === maps.results && cached.toolUpdates === maps.toolUpdates;
		const stable = reuse ? cached : maps;
		nextToolMaps.set(rowKey, stable);
		return stable;
	};
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const [nearBottom, setNearBottom] = useState(true);
	const jump = usePresence(!nearBottom);
	const pin = () => {
		const element = scrollerRef.current;
		if (element !== null) element.scrollTop = element.scrollHeight;
	};
	// Direct scroll listener: scroll does not bubble, and React's delegated handler is not
	// reliable across environments (happy-dom dispatches do not reach it).
	useEffect(() => {
		const element = scrollerRef.current;
		if (element === null) return;
		const handler = () => {
			const near = isNearBottom(element.scrollTop, element.clientHeight, element.scrollHeight);
			followRef.current = near;
			setNearBottom(near);
		};
		element.addEventListener("scroll", handler);
		return () => element.removeEventListener("scroll", handler);
	}, []);
	// content-visibility rows change scrollHeight after layout: keep pinning while following.
	useEffect(() => {
		const content = contentRef.current;
		const scroller = scrollerRef.current;
		if (content === null || scroller === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (followRef.current) pin();
		});
		observer.observe(content);
		// The scroller shrinks on composer autosize, window resize, or a mobile keyboard.
		observer.observe(scroller);
		return () => observer.disconnect();
	}, []);
	// A replaced snapshot always opens at the bottom; otherwise follow only while near it.
	const handledEntriesRef = useRef<readonly WireTranscriptEntry[] | null>(null);
	useLayoutEffect(() => {
		// `replaced` stays true for the same entries reference, so consume it once or a
		// slot update would yank a reader who has since scrolled up.
		if (replaced && handledEntriesRef.current !== entries) {
			followRef.current = true;
			setNearBottom(true);
		}
		handledEntriesRef.current = entries;
		if (followRef.current) pin();
	}, [entries, slot, working, replaced]);
	const slotVisible = slot !== undefined && slot !== null && !(slot.frozen && slot.entryId !== null && entryIds.has(slot.entryId));
	const showWorking = working && !(slotVisible && slotHasContent(slot));
	const isEmpty = rows.length === 0 && !slotVisible;
	const emptyMessage =
		connection === undefined ? undefined : connection === "connected" ? (snapshotReceived ? "No messages yet." : undefined) : EMPTY_STATE_MESSAGES[connection];
	const showSkeleton = isEmpty && emptyMessage === undefined;
	// One array: the live slot and its landed entry must share a parent for React to keep the keyed row mounted.
	const rowNodes: ReactNode[] = rows.map(({ entry, key, repeat }) => {
		const maps = toolMapsFor(key, entry.message.blocks);
		const slotKey = landed.get(key);
		if (slotKey !== undefined && entry.message.role !== "toolResult") {
			return <SlotRow key={`slot-${slotKey}`} slot={landedSlot(entry, slotKey)} repeat={repeat} {...maps} />;
		}
		return <EntryRow key={key} entry={entry} arrived={arrived.has(key)} repeat={repeat} {...maps} />;
	});
	if (slotVisible) {
		rowNodes.push(<SlotRow key={`slot-${slot.slotKey}`} slot={slot} {...toolMapsFor(`slot-${slot.slotKey}`, slot.blocks)} />);
	}
	toolMapsRef.current = nextToolMaps;
	return (
		<div className="rc-transcript-list" data-rc-scroller="true" ref={scrollerRef}>
			<div
				className="rc-transcript-content"
				ref={contentRef}
				role="log"
				aria-label="transcript"
				aria-relevant="additions"
			>
				{showSkeleton && (
					<div className="rc-skeleton" aria-hidden="true">
						<span className="rc-skeleton-line" />
						<span className="rc-skeleton-line" />
						<span className="rc-skeleton-line" />
					</div>
				)}
				{isEmpty && emptyMessage !== undefined && (
					<p className="rc-empty-state" data-rc-empty-state={connection}>
						{emptyMessage}
					</p>
				)}
				{rowNodes}
				{showWorking && (
					<div className="rc-working" data-rc-working="true">
						<StatusDot tone="live" activity="pulse" />
						<Shimmer>Working</Shimmer>
					</div>
				)}
			</div>
			{jump.mounted && (
				<div className="rc-jump-dock">
					<button
						type="button"
						className="rc-jump rc-pop"
						data-rc-jump="true"
						data-state={jump.state}
						onClick={() => {
							followRef.current = true;
							pin();
						}}
					>
						<Icon name="arrow-down" />
						Jump to latest
					</button>
				</div>
			)}
		</div>
	);
}
