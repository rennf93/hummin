/** `--no-json-deltas`: JSON mode drops message_update records; message_end
 * still carries the full assembled message for whole-message consumers. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../src/modes/print-mode.ts";

const { written } = vi.hoisted(() => ({ written: [] as string[] }));

vi.mock("../src/core/output-guard.ts", () => ({
	writeRawStdout: (text: string) => {
		written.push(text);
	},
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
}));

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: { hasHandlers: (eventType: string) => boolean; emit: ReturnType<typeof vi.fn> };
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createRuntimeHost(onPrompt: () => void): { session: FakeSession; runtimeHost: unknown } {
	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state: { messages: [] },
		extensionRunner: {
			hasHandlers: (eventType: string) => eventType === "session_shutdown",
			emit: vi.fn(async () => {}),
		},
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => onPrompt()),
		reload: vi.fn(async () => {}),
	};
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	};
	return { session, runtimeHost };
}

/** Fire one delta + one whole-message event through the session's subscribe
 * callback at prompt time (the writer is only wired up by then). */
function emitDuringPrompt(session: FakeSession, events: unknown[]): void {
	session.prompt.mockImplementation(async () => {
		const emit = session.subscribe.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
		for (const event of events) emit?.(event);
	});
}

function emittedTypes(): string[] {
	return written.map((line) => JSON.parse(line).type);
}

afterEach(() => {
	written.length = 0;
	vi.restoreAllMocks();
});

describe("json mode delta suppression", () => {
	it("drops message_update records when noJsonDeltas is set", async () => {
		const assistant = createAssistantMessage("done");
		const updateEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "do" },
		};
		const endEvent = { type: "message_end", message: assistant };
		const { session, runtimeHost } = createRuntimeHost(() => {});
		emitDuringPrompt(session, [updateEvent, endEvent]);

		const exitCode = await runPrintMode(runtimeHost as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			noJsonDeltas: true,
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(emittedTypes()).not.toContain("message_update");
		expect(emittedTypes()).toContain("message_end");
		// The whole message survives on message_end for consumers.
		const endLine = written.map((line) => JSON.parse(line)).find((event) => event.type === "message_end");
		expect((endLine?.message as AssistantMessage).content[0]).toEqual({ type: "text", text: "done" });
	});

	it("keeps streaming message_update records by default", async () => {
		const assistant = createAssistantMessage("done");
		const updateEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "do" },
		};
		const { session, runtimeHost } = createRuntimeHost(() => {});
		emitDuringPrompt(session, [updateEvent]);

		await runPrintMode(runtimeHost as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(emittedTypes()).toContain("message_update");
	});
});
