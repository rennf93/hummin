// Streaming slot tests: delta reassembly, defensive toolcall argument accumulation,
// slotKey isolation, and the message_end freeze. Mirrors the harness replay test at the
// protocol level; the component-level mirror lives in transcript.test.tsx.
import { describe, expect, it } from "vitest";
import type {
	AnyRemoteEvent,
	MessageDeltaPayload,
	MessageEndPayload,
	MessageStartPayload,
} from "../../harness/replay-log.ts";
import { expectKind, loadFixtureEvents } from "../test/corpus.ts";
import { applyStreamEvent, type LiveSlot } from "./stream-slot.ts";

const TS = "2026-01-01T00:00:00.000Z";

function start(slotKey: string, message: MessageStartPayload["message"]): AnyRemoteEvent {
	return { v: 1, seq: 0, ts: TS, type: "message_start", payload: { slotKey, message } };
}

function delta(slotKey: string, event: MessageDeltaPayload["event"]): AnyRemoteEvent {
	return { v: 1, seq: 1, ts: TS, type: "message_delta", payload: { slotKey, event } };
}

function end(slotKey: string, entryId: string, message: MessageEndPayload["message"]): AnyRemoteEvent {
	return { v: 1, seq: 2, ts: TS, type: "message_end", payload: { slotKey, entryId, message } };
}

const EMPTY_ASSISTANT: MessageStartPayload["message"] = { role: "assistant", blocks: [] };

describe("stream slot", () => {
	it("reassembles the fixture stream: text deltas join the final message text", () => {
		const events = loadFixtureEvents("hummin-longest.stream.events.json");
		let slot: LiveSlot | null = null;
		for (const event of events) slot = applyStreamEvent(slot, event);
		expect(slot).not.toBeNull();
		expect(slot?.frozen).toBe(true);
		expect(slot?.entryId).toBe("fx-5");
		const textBlock = slot?.blocks.find((b) => b.type === "text");
		expect(textBlock?.type === "text" ? textBlock.text : null).toBe(
			"Hi. Ready for a task in this repo or something else?",
		);
		const lastEvent = events[3];
		if (lastEvent === undefined) throw new Error("stream fixture is missing its message_end event");
		const endEvent = expectKind(lastEvent, "message_end");
		const finalBlock = endEvent.payload.message.blocks.find((b) => b.type === "text");
		expect(finalBlock?.type === "text" ? finalBlock.text : null).toBe(
			"Hi. Ready for a task in this repo or something else?",
		);
	});

	it("appends text and thinking deltas at their contentIndex, padding sparse indices", () => {
		let slot = applyStreamEvent(null, start("s1", EMPTY_ASSISTANT));
		slot = applyStreamEvent(slot, delta("s1", { type: "text_delta", contentIndex: 1, delta: "hel" }));
		slot = applyStreamEvent(slot, delta("s1", { type: "text_delta", contentIndex: 1, delta: "lo" }));
		slot = applyStreamEvent(slot, delta("s1", { type: "thinking_delta", contentIndex: 2, delta: "why" }));
		expect(slot?.blocks.length).toBe(3);
		expect(slot?.blocks[0]?.type).toBe("text");
		const first = slot?.blocks[0];
		expect(first?.type === "text" ? first.text : null).toBe("");
		const second = slot?.blocks[1];
		expect(second?.type === "text" ? second.text : null).toBe("hello");
		expect(slot?.blocks[2]?.type).toBe("thinking");
		const third = slot?.blocks[2];
		expect(third?.type === "thinking" ? third.text : null).toBe("why");
	});

	it("accumulates toolcall argument deltas defensively and parses at toolcall_end", () => {
		let slot = applyStreamEvent(null, start("s1", EMPTY_ASSISTANT));
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_start", contentIndex: 0 }));
		const partial = slot?.blocks[0];
		expect(partial?.type).toBe("toolCall");
		expect(partial?.type === "toolCall" ? partial.partial : null).toBe(true);
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_delta", contentIndex: 0, delta: '{"comm' }));
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_delta", contentIndex: 0, delta: 'and": "ls -la"}' }));
		expect(slot?.blocks[0]?.type === "toolCall" ? slot.blocks[0].arguments : null).toEqual({ command: "ls -la" });
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_end", contentIndex: 0 }));
		const call = slot?.blocks[0];
		expect(call?.type).toBe("toolCall");
		expect(call?.type === "toolCall" ? call.partial : null).toBe(false);
		expect(call?.type === "toolCall" ? call.arguments : null).toEqual({ command: "ls -la" });
		expect(call?.type === "toolCall" ? call.argumentsError : undefined).toBeUndefined();
	});

	it("surfaces argumentsError when accumulated toolcall args never parse", () => {
		let slot = applyStreamEvent(null, start("s1", EMPTY_ASSISTANT));
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_start", contentIndex: 0 }));
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_delta", contentIndex: 0, delta: '{"command": ' }));
		// A still-invalid tail never blanks the last good incremental parse during streaming.
		expect(slot?.blocks[0]?.type === "toolCall" ? slot.blocks[0].arguments : null).toEqual({});
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_end", contentIndex: 0 }));
		const call = slot?.blocks[0];
		expect(call?.type === "toolCall" ? call.arguments : null).toEqual({});
		expect(call?.type === "toolCall" ? call.argumentsError : undefined).toContain("not valid JSON");
	});

	it("stops parsing argument deltas above the streaming parse limit but always parses at end", () => {
		const value = "x".repeat(6000);
		const full = JSON.stringify({ pad: value });
		const half = full.length / 2;
		let slot = applyStreamEvent(null, start("s1", EMPTY_ASSISTANT));
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_start", contentIndex: 0 }));
		slot = applyStreamEvent(
			slot,
			delta("s1", { type: "toolcall_delta", contentIndex: 0, delta: full.slice(0, half) }),
		);
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_delta", contentIndex: 0, delta: full.slice(half) }));
		expect(slot?.blocks[0]?.type === "toolCall" ? (slot.blocks[0].argsRaw ?? "").length : 0).toBe(full.length);
		expect(slot?.blocks[0]?.type === "toolCall" ? Object.keys(slot.blocks[0].arguments).length : 0).toBe(0);
		slot = applyStreamEvent(slot, delta("s1", { type: "toolcall_end", contentIndex: 0 }));
		expect(slot?.blocks[0]?.type === "toolCall" ? slot.blocks[0].arguments : null).toEqual({ pad: value });
	});

	it("binds the entryId and freezes on message_end; events for other slots are ignored", () => {
		let slot = applyStreamEvent(null, start("s1", EMPTY_ASSISTANT));
		slot = applyStreamEvent(slot, delta("s2", { type: "text_delta", contentIndex: 0, delta: "foreign" }));
		expect(slot?.blocks.length).toBe(0);
		const finalMessage: MessageEndPayload["message"] = {
			role: "assistant",
			blocks: [{ type: "text", text: "final" }],
			durationMs: 12,
		};
		slot = applyStreamEvent(slot, end("s1", "fx-9", finalMessage));
		expect(slot?.frozen).toBe(true);
		expect(slot?.entryId).toBe("fx-9");
		expect(slot?.durationMs).toBe(12);
		expect(slot?.blocks[0]?.type).toBe("text");
		const bound = slot?.blocks[0];
		expect(bound?.type === "text" ? bound.text : null).toBe("final");
		// frozen slots ignore further deltas for the same key
		const frozen = slot;
		const after = applyStreamEvent(frozen, delta("s1", { type: "text_delta", contentIndex: 0, delta: "more" }));
		expect(after).toBe(frozen);
	});

	it("passes through non-message protocol events unchanged", () => {
		const slot: LiveSlot = {
			slotKey: "s1",
			entryId: null,
			frozen: false,
			role: "assistant",
			blocks: [],
		};
		const snapshot: AnyRemoteEvent = {
			v: 1,
			seq: 0,
			ts: TS,
			type: "snapshot",
			payload: {
				host: { origin: "corpus://", label: "x" },
				protocolVersion: 1,
				sessionId: "s",
				sessionName: "s",
				status: { kind: "idle", model: null },
				messages: [],
				holds: [],
				queue: { items: [], terminalQueued: 0 },
			},
		};
		expect(applyStreamEvent(slot, snapshot)).toBe(slot);
		expect(applyStreamEvent(slot, { v: 1, seq: 1, ts: TS, type: "ping", payload: {} })).toBe(slot);
		// a message_start replaces an unfrozen slot
		const replaced = applyStreamEvent(slot, start("s2", EMPTY_ASSISTANT));
		expect(replaced?.slotKey).toBe("s2");
		expect(replaced?.slotKey).not.toBe(slot.slotKey);
	});
});

describe("stream slot contentIndex guard", () => {
	it("ignores deltas whose contentIndex is not an integer in 0..255", () => {
		const opened = applyStreamEvent(null, start("k", EMPTY_ASSISTANT));
		for (const contentIndex of [-1, 1.5, 256, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
			for (const event of [
				{ type: "text_delta", contentIndex, delta: "x" },
				{ type: "thinking_delta", contentIndex, delta: "x" },
				{ type: "toolcall_start", contentIndex },
			] as const) {
				const next = applyStreamEvent(opened, delta("k", event));
				expect(next, `${event.type} ${contentIndex}`).toBe(opened);
			}
		}
		const ok = applyStreamEvent(opened, delta("k", { type: "text_delta", contentIndex: 255, delta: "x" }));
		expect(ok?.blocks.length).toBe(256);
	});
});
