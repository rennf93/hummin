import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { setNotificationGate } from "../src/core/terminal-notifications.ts";
import {
	buildWarpCliAgentSequence,
	emitWarpCliAgentEvent,
	isWarpCliAgentActive,
	WARP_CLI_AGENT_PROTOCOL_VERSION,
	type WarpCliAgentEvent,
} from "../src/core/warp-cli-agent.ts";
import { agentOutcomeFromMessages, userMessageText, default as warpExtension } from "../src/extensions/warp/index.ts";

const OSC_777_PREFIX = "\x1b]777;notify;warp://cli-agent;";

/** Parse the JSON envelope out of an emitted sequence. */
function parseEnvelope(sequence: string): Record<string, unknown> {
	expect(sequence.startsWith(OSC_777_PREFIX)).toBe(true);
	expect(sequence.endsWith("\x07")).toBe(true);
	return JSON.parse(sequence.slice(OSC_777_PREFIX.length, -1)) as Record<string, unknown>;
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistantMessage(stopReason: StopReason, text?: string, errorMessage?: string): AgentMessage {
	return {
		role: "assistant",
		content: text === undefined ? [] : [{ type: "text", text }],
		api: "openai-completions",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function warpEvent(partial: Partial<WarpCliAgentEvent>): WarpCliAgentEvent {
	return { event: "stop", sessionId: "s1", cwd: "/tmp/proj", ...partial };
}

describe("isWarpCliAgentActive", () => {
	it("is true when Warp negotiated version 1 or higher", () => {
		expect(isWarpCliAgentActive({ WARP_CLI_AGENT_PROTOCOL_VERSION: "1" })).toBe(true);
		expect(isWarpCliAgentActive({ WARP_CLI_AGENT_PROTOCOL_VERSION: "2" })).toBe(true);
	});

	it("is false without negotiation or on garbage", () => {
		expect(isWarpCliAgentActive({})).toBe(false);
		expect(isWarpCliAgentActive({ WARP_CLI_AGENT_PROTOCOL_VERSION: "0" })).toBe(false);
		expect(isWarpCliAgentActive({ WARP_CLI_AGENT_PROTOCOL_VERSION: "abc" })).toBe(false);
		expect(isWarpCliAgentActive({ WARP_CLI_AGENT_PROTOCOL_VERSION: "-3" })).toBe(false);
	});
});

describe("buildWarpCliAgentSequence", () => {
	it("serializes the envelope with protocol version and agent identity", () => {
		const envelope = parseEnvelope(buildWarpCliAgentSequence(warpEvent({ event: "session_start" }), {}));
		expect(envelope).toEqual({
			v: WARP_CLI_AGENT_PROTOCOL_VERSION,
			agent: "hummin",
			event: "session_start",
			session_id: "s1",
			cwd: "/tmp/proj",
		});
	});

	it("omits absent optional fields and empty session ids", () => {
		const envelope = parseEnvelope(buildWarpCliAgentSequence(warpEvent({ sessionId: "", response: "done" }), {}));
		expect(envelope).toEqual({
			v: WARP_CLI_AGENT_PROTOCOL_VERSION,
			agent: "hummin",
			event: "stop",
			cwd: "/tmp/proj",
			response: "done",
		});
	});

	it("sanitizes control bytes out of free-text fields", () => {
		const envelope = parseEnvelope(
			buildWarpCliAgentSequence(warpEvent({ query: "fix \x1b]0;pwned\x07 the bug" }), {}),
		);
		expect(envelope.query).toBe("fix  ]0;pwned  the bug");
	});

	it("bounds long text with an ellipsis", () => {
		const envelope = parseEnvelope(buildWarpCliAgentSequence(warpEvent({ response: "x".repeat(3000) }), {}));
		expect(envelope.response).toBe(`${"x".repeat(1999)}…`);
	});

	it("emits a bare OSC sequence outside tmux", () => {
		const sequence = buildWarpCliAgentSequence(warpEvent({}), {});
		expect(sequence.startsWith("\x1b]777;")).toBe(true);
		expect(sequence).not.toContain("\x1bPtmux;");
	});

	it("wraps the sequence for tmux passthrough with doubled ESC bytes", () => {
		const sequence = buildWarpCliAgentSequence(warpEvent({}), { TMUX: "/tmp/tmux-0,p,0" });
		expect(sequence.startsWith("\x1bPtmux;")).toBe(true);
		expect(sequence.endsWith("\x1b\\")).toBe(true);
		const inner = sequence.slice("\x1bPtmux;".length, -"\x1b\\".length);
		expect(inner).toBe(
			`\x1b\x1b]777;notify;warp://cli-agent;{"v":1,"agent":"hummin","event":"stop","session_id":"s1","cwd":"/tmp/proj"}\x07`,
		);
	});
});

describe("emitWarpCliAgentEvent", () => {
	afterEach(() => {
		setNotificationGate(undefined);
	});

	it("writes the sequence when emission is allowed", () => {
		const written: string[] = [];
		emitWarpCliAgentEvent(warpEvent({ event: "prompt_submit", query: "hi" }), (data) => written.push(data));
		expect(written).toHaveLength(1);
		expect(parseEnvelope(written[0]).event).toBe("prompt_submit");
	});

	it("writes nothing when the mode gate suppresses emission (print/RPC stdout)", () => {
		setNotificationGate(() => false);
		const written: string[] = [];
		emitWarpCliAgentEvent(warpEvent({}), (data) => written.push(data));
		expect(written).toHaveLength(0);
	});
});

describe("userMessageText", () => {
	it("passes string content through", () => {
		expect(userMessageText(userMessage("fix the bug"))).toBe("fix the bug");
	});

	it("joins text blocks and ignores images", () => {
		const message = {
			role: "user",
			content: [
				{ type: "text" as const, text: "look at" },
				{ type: "image" as const, data: "xxx", mimeType: "image/png" },
				{ type: "text" as const, text: "this" },
			],
			timestamp: 0,
		} as AgentMessage;
		expect(userMessageText(message)).toBe("look at\nthis");
	});

	it("returns empty text for non-user messages", () => {
		expect(userMessageText(assistantMessage("stop", "nope"))).toBe("");
	});
});

describe("agentOutcomeFromMessages", () => {
	it("reports a completed run with the final assistant text", () => {
		const outcome = agentOutcomeFromMessages([
			userMessage("do it"),
			assistantMessage("toolUse", "calling tool"),
			assistantMessage("stop", "all done"),
		]);
		expect(outcome).toEqual({ event: "stop", response: "all done" });
	});

	it("reports failures without a response payload", () => {
		const outcome = agentOutcomeFromMessages([assistantMessage("error", undefined, "rate limited")]);
		expect(outcome).toEqual({ event: "stop_failure" });
	});

	it("returns undefined for aborted runs so Warp never marks a completed task", () => {
		expect(agentOutcomeFromMessages([assistantMessage("aborted", "partial")])).toBeUndefined();
	});

	it("returns undefined when no assistant message exists", () => {
		expect(agentOutcomeFromMessages([userMessage("hi")])).toBeUndefined();
	});
});

describe("warpCliAgentExtension", () => {
	it("is a factory function, inert until Warp negotiates the protocol", () => {
		expect(typeof warpExtension).toBe("function");
		expect(isWarpCliAgentActive({})).toBe(false);
	});
});
