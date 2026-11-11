/**
 * lib/remote-console/custom-messages: wire conversion for extension custom
 * messages (session entry type "custom_message", live message role "custom").
 * toWireMessage (protocol.ts) carries neither customType nor details, and a
 * message the terminal hides (falsy display, e.g. the memory recall injection)
 * must reach the console as a typed marker only, never as text, so the
 * conversion lives here.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toWireMessage, type WireAgentMessage, type WireTranscriptEntry } from "./protocol.ts";

const MAX_DETAIL_STRING_CHARS = 200;
const MAX_DETAIL_ARRAY_ITEMS = 20;
const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_KEY_CHARS = 64;
const FORBIDDEN_DETAIL_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RECALL_CUSTOM_TYPE = "hummin-memory-recall";

type Scalar = string | number | boolean | null;

function boundScalar(value: unknown): Scalar | undefined {
	if (typeof value === "string") {
		return value.length > MAX_DETAIL_STRING_CHARS ? value.slice(0, MAX_DETAIL_STRING_CHARS) : value;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean" || value === null) return value;
	return undefined;
}

/** At most 20 keys; JSON-safe scalars, and arrays of at most 20 scalars (extra items and
 * non-scalar items are dropped); strings are cut to 200 chars. Everything
 * else, nested objects included, is dropped. */
export function boundDetails(details: unknown): Record<string, unknown> | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const bounded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (Object.keys(bounded).length >= MAX_DETAIL_KEYS) break;
		if (FORBIDDEN_DETAIL_KEYS.has(key) || key.length > MAX_DETAIL_KEY_CHARS) continue;
		if (Array.isArray(value)) {
			const items: Scalar[] = [];
			for (const item of value) {
				const scalar = boundScalar(item);
				if (scalar !== undefined) items.push(scalar);
				if (items.length >= MAX_DETAIL_ARRAY_ITEMS) break;
			}
			bounded[key] = items;
			continue;
		}
		const scalar = boundScalar(value);
		if (scalar !== undefined) bounded[key] = scalar;
	}
	return bounded;
}

interface CustomLike {
	customType: string;
	content: unknown;
	display?: boolean;
	details?: unknown;
}

/** Wire form of a custom message or entry. Text blocks are sent only when
 * display is truthy, the terminal's own rule. */
export function customToWireMessage(custom: CustomLike): WireAgentMessage {
	let details = boundDetails(custom.details);
	if (custom.customType === RECALL_CUSTOM_TYPE) {
		const raw = (custom.details as { lessonIds?: unknown } | undefined)?.lessonIds;
		const lessonCount = Array.isArray(raw) ? raw.filter((id) => typeof id === "string").length : 0;
		details = { ...details, lessonCount };
		delete details.lessonIds;
	}
	const blocks = custom.display
		? toWireMessage({ role: "user", content: custom.content ?? [], timestamp: 0 } as AgentMessage).blocks
		: [];
	return { role: "custom", customType: custom.customType, ...(details ? { details } : {}), blocks };
}

/** Live custom messages (role "custom") flow through message_start/end. */
export function isCustomAgentMessage(message: unknown): message is CustomLike & { role: "custom" } {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "custom" &&
		typeof (message as { customType?: unknown }).customType === "string"
	);
}

/** Snapshot conversion of a "custom_message" session entry. */
export function customEntryToWire(entry: {
	id: string;
	timestamp: string;
	customType: string;
	content: unknown;
	display: boolean;
	details?: unknown;
}): WireTranscriptEntry {
	return {
		entryId: entry.id,
		timestamp: entry.timestamp,
		message: customToWireMessage(entry),
	};
}
