/**
 * renderer/test/corpus: test-side loader for the harness fixtures and corruption
 * corpus. Fixture and corpus files are parsed JSON from disk, a trust boundary:
 * the envelope is checked here and the tests narrow further with expectKind.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AnyRemoteEvent,
	RemoteEvent,
	RemoteEventType,
	SnapshotPayload,
	WireTranscriptEntry,
} from "../../harness/replay-log.ts";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "harness");
const CORPUS_DIR = join(HARNESS_DIR, "corpus");
const FIXTURES_DIR = join(HARNESS_DIR, "fixtures");

const REMOTE_EVENT_TYPES: readonly RemoteEventType[] = [
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
	"ping",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertEvents(value: unknown, label: string): AnyRemoteEvent[] {
	if (!Array.isArray(value)) throw new Error(`${label}: expected an event array`);
	for (const [index, raw] of value.entries()) {
		const where = `${label}[${index}]`;
		if (!isRecord(raw)) throw new Error(`${where}: event is not an object`);
		if (raw.v !== 1) throw new Error(`${where}: expected protocol v1`);
		if (typeof raw.type !== "string" || !REMOTE_EVENT_TYPES.some((t) => t === raw.type)) {
			throw new Error(`${where}: unknown event type ${String(raw.type)}`);
		}
		if (!isRecord(raw.payload)) throw new Error(`${where}: payload is not an object`);
	}
	// Cast is sound: the envelope and event-type union were validated above.
	return value as AnyRemoteEvent[];
}

/** Loads one corruption corpus file as protocol events. */
export function loadCorpusEvents(file: string): AnyRemoteEvent[] {
	const raw: unknown = JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8"));
	return assertEvents(raw, file);
}

/** Loads one fixture file as protocol events. */
export function loadFixtureEvents(file: string): AnyRemoteEvent[] {
	const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
	return assertEvents(raw, file);
}

/** Narrows an event by its type discriminator or fails loudly. */
export function expectKind<K extends RemoteEventType>(event: AnyRemoteEvent, kind: K): RemoteEvent<K> {
	if (event.type !== kind) throw new Error(`expected ${kind}, got ${event.type}`);
	// Cast is sound: type is the discriminator of the AnyRemoteEvent union.
	return event as RemoteEvent<K>;
}

/** Snapshot payload of a single-snapshot fixture or corpus file. */
export function snapshotPayload(events: AnyRemoteEvent[]): SnapshotPayload {
	const first = events[0];
	if (first === undefined) throw new Error("expected at least one event, got none");
	return expectKind(first, "snapshot").payload;
}

/** Snapshot transcript entries of a single-snapshot fixture or corpus file. */
export function snapshotEntries(events: AnyRemoteEvent[]): WireTranscriptEntry[] {
	return snapshotPayload(events).messages;
}

/** Concatenated text-block content of a snapshot's messages. */
export function snapshotText(events: AnyRemoteEvent[]): string {
	return snapshotEntries(events)
		.flatMap((entry) => entry.message.blocks)
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}
