/**
 * renderer/transcript/stream-slot: folds message_start / message_delta / message_end
 * protocol events into the one live streaming slot the transcript renders below the
 * snapshot entries. text_delta and thinking_delta append into the block at their
 * contentIndex; toolcall_delta accumulates raw argument JSON defensively (parse
 * failures never throw, they surface as argumentsError at toolcall_end);
 * message_end binds the stable entryId, adopts the final message, and freezes the
 * slot. Copy-on-write throughout: the previous slot object is never mutated.
 */
import type {
	AnyRemoteEvent,
	StreamDeltaEvent,
	WireAgentMessage,
	WireContentBlock,
	WireImageElidedBlock,
	WireTextBlock,
	WireThinkingBlock,
	WireToolCallBlock,
} from "../../harness/replay-log.ts";

/** Argument JSON parse attempts during streaming stop above this length; the final
 * parse at toolcall_end always runs. Keeps O(n^2) parse cost off the delta hot path. */
const STREAM_ARGS_PARSE_LIMIT = 4096;

/** A wire tool call block carrying the renderer's raw argument accumulation. */
export interface LiveToolCallBlock extends WireToolCallBlock {
	argsRaw?: string;
	partial?: boolean;
}

/** Slot blocks are wire content blocks; tool calls may still be accumulating args. */
export type LiveSlotBlock = WireTextBlock | WireThinkingBlock | WireImageElidedBlock | LiveToolCallBlock;

export interface LiveSlot {
	slotKey: string;
	/** Stable session-entry id, bound by message_end; null while streaming. */
	entryId: string | null;
	frozen: boolean;
	role: WireAgentMessage["role"];
	/** Extension notice type and bounded details of a custom message. */
	customType?: string;
	details?: Record<string, unknown>;
	blocks: LiveSlotBlock[];
	durationMs?: number;
	stopReason?: string;
	usage?: WireAgentMessage["usage"];
}

/** Applies one protocol event to the slot. Non-message events and events for another
 * slotKey pass through unchanged; a message_start replaces the current slot (the
 * transcript deduplicates a frozen slot against entries that have landed). */
export function applyStreamEvent(slot: LiveSlot | null, event: AnyRemoteEvent): LiveSlot | null {
	if (event.type === "message_start") return startSlot(event.payload.slotKey, event.payload.message);
	if (event.type === "message_delta") {
		if (slot === null || slot.frozen || event.payload.slotKey !== slot.slotKey) return slot;
		return applyDelta(slot, event.payload.event);
	}
	if (event.type === "message_end") {
		if (slot === null || event.payload.slotKey !== slot.slotKey) return slot;
		return endSlot(slot, event.payload);
	}
	return slot;
}

function startSlot(slotKey: string, message: WireAgentMessage): LiveSlot {
	return {
		slotKey,
		entryId: null,
		frozen: false,
		role: message.role,
		customType: message.customType,
		details: message.details,
		blocks: message.blocks.map(emptyLiveBlock),
		durationMs: message.durationMs,
		stopReason: message.stopReason,
		usage: message.usage,
	};
}

function endSlot(slot: LiveSlot, payload: { entryId: string; message: WireAgentMessage }): LiveSlot {
	return {
		slotKey: slot.slotKey,
		entryId: payload.entryId,
		frozen: true,
		role: payload.message.role,
		customType: payload.message.customType,
		details: payload.message.details,
		blocks: payload.message.blocks.map(emptyLiveBlock),
		durationMs: payload.message.durationMs,
		stopReason: payload.message.stopReason,
		usage: payload.message.usage,
	};
}

/** Normalizes a wire block into the live form: tool calls gain the raw argument
 * accumulation fields, everything else passes through. */
function emptyLiveBlock(block: WireContentBlock): LiveSlotBlock {
	if (block.type === "toolCall") {
		const live: LiveToolCallBlock = { ...block, argsRaw: "", partial: true };
		return live;
	}
	return block;
}

/** Largest wire contentIndex the slot will pad up to; anything else is a hostile or corrupt delta. */
const MAX_CONTENT_INDEX = 255;

function applyDelta(slot: LiveSlot, event: StreamDeltaEvent): LiveSlot {
	const index: unknown = event.contentIndex;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > MAX_CONTENT_INDEX) return slot;
	if (event.type === "text_delta")
		return { ...slot, blocks: appendDelta(slot.blocks, event.contentIndex, event.delta, "text") };
	if (event.type === "thinking_delta") {
		return { ...slot, blocks: appendDelta(slot.blocks, event.contentIndex, event.delta, "thinking") };
	}
	if (event.type === "toolcall_start") return { ...slot, blocks: startToolCall(slot.blocks, event.contentIndex) };
	if (event.type === "toolcall_delta")
		return { ...slot, blocks: deltaToolCall(slot.blocks, event.contentIndex, event.delta) };
	if (event.type === "toolcall_end") return { ...slot, blocks: endToolCall(slot.blocks, event.contentIndex) };
	return slot;
}

function padAndCopy(blocks: readonly LiveSlotBlock[], index: number, fill: () => LiveSlotBlock): LiveSlotBlock[] {
	const next = [...blocks];
	while (next.length < index) next.push(fill());
	return next;
}

function textFill(): WireTextBlock {
	return { type: "text", text: "" };
}

function thinkingFill(): WireThinkingBlock {
	return { type: "thinking", text: "" };
}

function appendDelta(
	blocks: readonly LiveSlotBlock[],
	index: number,
	delta: string,
	kind: "text" | "thinking",
): LiveSlotBlock[] {
	const next = padAndCopy(blocks, index, kind === "text" ? textFill : thinkingFill);
	const target = next[index];
	// contentIndex is the wire's block identity: a matching kind appends, anything else
	// at that index is replaced because the sender owns the slot's shape.
	if (target !== undefined && target.type === kind) {
		next[index] = { type: kind, text: target.text + delta };
	} else {
		next[index] = { type: kind, text: delta };
	}
	return next;
}

function startToolCall(blocks: readonly LiveSlotBlock[], index: number): LiveSlotBlock[] {
	const next = padAndCopy(blocks, index, textFill);
	next[index] = { type: "toolCall", id: "", name: "", arguments: {}, argsRaw: "", partial: true };
	return next;
}

function deltaToolCall(blocks: readonly LiveSlotBlock[], index: number, delta: string): LiveSlotBlock[] {
	const target = blocks[index];
	if (target === undefined || target.type !== "toolCall") return [...blocks];
	const argsRaw = (target.argsRaw ?? "") + delta;
	const next = [...blocks];
	const live: LiveToolCallBlock = { ...target, argsRaw, partial: true };
	const parsed = tryParseArgs(argsRaw, argsRaw.length <= STREAM_ARGS_PARSE_LIMIT);
	// Keep the last good incremental parse so a still-invalid tail never blanks the card.
	live.arguments = parsed ?? target.arguments;
	next[index] = live;
	return next;
}

function endToolCall(blocks: readonly LiveSlotBlock[], index: number): LiveSlotBlock[] {
	const target = blocks[index];
	if (target === undefined || target.type !== "toolCall") return [...blocks];
	const argsRaw = target.argsRaw ?? "";
	const parsed = tryParseArgs(argsRaw, true);
	const next = [...blocks];
	if (parsed !== undefined) {
		next[index] = { ...target, arguments: parsed, partial: false };
	} else {
		next[index] = {
			...target,
			arguments: {},
			argumentsError: `arguments are not valid JSON: ${glance(argsRaw)}`,
			partial: false,
		};
	}
	return next;
}

function tryParseArgs(raw: string, attempt: boolean): Record<string, unknown> | undefined {
	if (!attempt || raw.trim() === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function glance(raw: string, max = 200): string {
	const flat = raw.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}
