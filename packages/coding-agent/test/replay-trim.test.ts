// hummin: replay-trim unit tests - completed-turn rewriting of the per-request
// context (thinking strip + old tool-result prune), boundary logic, provider
// safety rules, and copy-on-write guarantees.

import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryModelsStore,
	type Message,
	type Model,
	type Provider,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resolveReplayTrimSettings, trimReplayContext } from "../src/core/replay-trim.ts";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

function think(text: string, signature?: string) {
	return { type: "thinking" as const, thinking: text, ...(signature ? { thinkingSignature: signature } : {}) };
}

const ON = resolveReplayTrimSettings({ thinking: true, toolResults: false }); // strip-only (lossless replay)
const ALL = resolveReplayTrimSettings({ thinking: true, toolResults: true }); // same as built-in defaults
const OFF = resolveReplayTrimSettings({ thinking: false, toolResults: false });

function context(messages: Message[]) {
	return { messages };
}

describe("resolveReplayTrimSettings", () => {
	it("defaults to thinking=on, toolResults=on (zcode-token-proxy all-mode parity)", () => {
		expect(resolveReplayTrimSettings(undefined)).toEqual({
			thinking: true,
			toolResults: true,
			toolResultCap: 2000,
			toolResultTail: 200,
		});
	});

	it("clamps negative cap/tail to zero", () => {
		expect(resolveReplayTrimSettings({ toolResultCap: -5, toolResultTail: -1 })).toEqual({
			thinking: true,
			toolResults: true,
			toolResultCap: 0,
			toolResultTail: 0,
		});
	});
});

describe("trimReplayContext - thinking strip", () => {
	it("strips thinking in completed turns, keeps the active loop untouched", () => {
		const ctx = context([
			user("first"),
			assistant([think("old reasoning", "reasoning_content"), { type: "text", text: "answer one" }]),
			user("second"),
			assistant([
				think("live reasoning", "reasoning_content"),
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
			]),
			toolResult("t1", "live tool output"),
		]);
		const out = trimReplayContext(ctx, "openai-completions", ON);
		expect(out).not.toBe(ctx);
		expect((out.messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "answer one" }]);
		expect((out.messages[3] as AssistantMessage).content).toHaveLength(2); // live thinking kept
		expect(out.messages[4]).toBe(ctx.messages[4]); // untouched message keeps identity
	});

	it("strips signed thinking on anthropic-messages but keeps redacted thinking", () => {
		const ctx = context([
			user("q"),
			assistant([think("reasoned", "real-opaque-signature"), { type: "text", text: "a" }]),
			assistant([
				{ type: "thinking", thinking: "encrypted", thinkingSignature: "opaque-blob", redacted: true },
				{ type: "text", text: "b" },
			]),
			user("next"),
		]);
		const out = trimReplayContext(ctx, "anthropic-messages", ON);
		expect((out.messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "a" }]);
		expect((out.messages[2] as AssistantMessage).content).toHaveLength(2); // redacted kept
	});

	it("on openai-completions strips plain reasoning-field signatures and keeps structured replay data", () => {
		const ctx = context([
			user("q"),
			assistant([think("a", "reasoning"), { type: "text", text: "x" }]),
			assistant([think("b", "reasoning_content"), { type: "text", text: "y" }]),
			assistant([think("c", '{"type":"reasoning_details","encrypted":"..."}'), { type: "text", text: "z" }]),
			assistant([think("no signature at all"), { type: "text", text: "w" }]),
			user("next"),
		]);
		const out = trimReplayContext(ctx, "openai-completions", ON);
		expect((out.messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "x" }]);
		expect((out.messages[2] as AssistantMessage).content).toEqual([{ type: "text", text: "y" }]);
		expect((out.messages[3] as AssistantMessage).content).toHaveLength(2); // structured signature kept
		expect((out.messages[4] as AssistantMessage).content).toEqual([{ type: "text", text: "w" }]);
	});

	it("keeps everything for unknown APIs", () => {
		const ctx = context([user("q"), assistant([think("r", "sig")]), user("next")]);
		expect(trimReplayContext(ctx, "google-generative-ai", ON)).toBe(ctx);
	});

	it("never empties a thinking-only assistant message", () => {
		const ctx = context([user("q"), assistant([think("only thinking", "sig")]), user("next")]);
		const out = trimReplayContext(ctx, "anthropic-messages", ON);
		expect((out.messages[1] as AssistantMessage).content).toHaveLength(1); // kept intact
	});

	it("returns the same reference when nothing changes", () => {
		const ctx = context([user("q"), assistant([{ type: "text", text: "plain" }]), user("next")]);
		expect(trimReplayContext(ctx, "anthropic-messages", ON)).toBe(ctx);
		expect(trimReplayContext(ctx, "anthropic-messages", OFF)).toBe(ctx);
	});

	it("does not mutate the input messages", () => {
		const ctx = context([user("q"), assistant([think("r", "sig"), { type: "text", text: "a" }]), user("next")]);
		trimReplayContext(ctx, "anthropic-messages", ON);
		expect((ctx.messages[1] as AssistantMessage).content).toHaveLength(2);
	});

	it("handles empty and user-only histories", () => {
		const empty = context([]);
		expect(trimReplayContext(empty, "anthropic-messages", ON)).toBe(empty);
		const only = context([user("only")]);
		expect(trimReplayContext(only, "anthropic-messages", ON)).toBe(only);
	});
});

describe("trimReplayContext - tool-result pruning", () => {
	const LONG = "x".repeat(5000);
	it("prunes long old tool results to head+marker+tail, keeps short ones", () => {
		const ctx = context([
			user("q"),
			toolResult("t0", `HEAD ${LONG} TAIL`),
			toolResult("t0b", "short output"),
			user("next"),
		]);
		const out = trimReplayContext(ctx, "anthropic-messages", ALL);
		const pruned = (out.messages[1] as ToolResultMessage).content[0] as { type: "text"; text: string };
		expect(pruned.text.startsWith("HEAD ")).toBe(true);
		expect(pruned.text.endsWith(" TAIL")).toBe(true);
		expect(pruned.text).toContain("old tool result trimmed");
		expect(pruned.text.length).toBeLessThan(3000);
		expect((out.messages[2] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "short output" });
	});

	it("tool-result pruning disabled when toolResults: false", () => {
		const ctx = context([user("q"), toolResult("t0", `HEAD ${LONG} TAIL`), user("next")]);
		expect(trimReplayContext(ctx, "anthropic-messages", ON)).toBe(ctx);
	});

	it("leaves the active tool loop untouched", () => {
		const ctx = context([user("q"), user("second"), toolResult("t1", `HEAD ${LONG} TAIL`)]);
		const out = trimReplayContext(ctx, "anthropic-messages", ALL);
		expect(out.messages[2]).toBe(ctx.messages[2]);
	});

	it("keeps image blocks while pruning text", () => {
		const ctx = context([
			user("q"),
			{
				...toolResult("t0", `HEAD ${LONG} TAIL`),
				content: [
					{ type: "text" as const, text: `HEAD ${LONG} TAIL` },
					{ type: "image" as const, mimeType: "image/png", data: "aGk=" },
				],
			},
			user("next"),
		]);
		const out = trimReplayContext(ctx, "anthropic-messages", ALL);
		const content = (out.messages[1] as ToolResultMessage).content;
		expect(content).toHaveLength(2);
		expect(content[1]).toEqual({ type: "image", mimeType: "image/png", data: "aGk=" });
	});
});

describe("ModelRuntime replay-trim wiring", () => {
	async function createCapturingRuntime(seen: Message[][]) {
		const testModel: Model<"openai-completions"> = {
			id: "trim-test",
			name: "trim-test",
			api: "openai-completions",
			provider: "trim-test",
			baseUrl: "https://example.test/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const provider: Provider = {
			id: "trim-test",
			name: "Trim Test",
			auth: {
				apiKey: {
					name: "key",
					check: async ({ credential }) => (credential?.key ? { type: "api_key", source: "stored" } : undefined),
					resolve: async ({ credential }) =>
						credential?.key
							? { auth: { apiKey: credential.key, baseUrl: "https://example.test/v1" }, source: "stored" }
							: undefined,
				},
			},
			getModels: () => [testModel],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: (_model, transcript) => {
				seen.push(transcript.messages);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "ok" }]) });
				return stream;
			},
		};
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ "trim-test": { type: "api_key", key: "k" } }),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(provider);
		return { runtime, testModel };
	}

	function replayContext() {
		return {
			messages: [user("q"), assistant([think("r", "reasoning_content"), { type: "text", text: "a" }]), user("next")],
		};
	}

	it("wired runtime trims by default (absent key = defaults on)", async () => {
		const seen: Message[][] = [];
		const { runtime, testModel } = await createCapturingRuntime(seen);
		runtime.setReplayTrimSettingsSource(() => ({}));
		await runtime.streamSimple(testModel, replayContext()).result();
		expect((seen[0]?.[1] as AssistantMessage).content).toEqual([{ type: "text", text: "a" }]);
	});

	it("wired runtime passes thinking through when the setting is off", async () => {
		const seen: Message[][] = [];
		const { runtime, testModel } = await createCapturingRuntime(seen);
		runtime.setReplayTrimSettingsSource(() => ({ thinking: false }));
		await runtime.streamSimple(testModel, replayContext()).result();
		expect((seen[0]?.[1] as AssistantMessage).content).toHaveLength(2);
	});

	it("unwired runtime keeps exact upstream behavior", async () => {
		const seen: Message[][] = [];
		const { runtime, testModel } = await createCapturingRuntime(seen);
		await runtime.streamSimple(testModel, replayContext()).result();
		expect((seen[0]?.[1] as AssistantMessage).content).toHaveLength(2);
	});
});
