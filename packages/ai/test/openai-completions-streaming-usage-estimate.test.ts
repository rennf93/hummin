import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const chunk = (delta: Record<string, unknown>): unknown => ({
	id: "chatcmpl-1",
	object: "chat.completion.chunk",
	created: 1,
	model: model.id,
	choices: [{ index: 0, delta, finish_reason: null }],
});

/** Run the stream, capturing usage.output after every event. */
async function collectOutputProgression(): Promise<number[]> {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
	const progression: number[] = [];
	let message: { usage: { output: number } } | undefined;
	for await (const event of stream) {
		const partial = (event as { partial?: { usage: { output: number } } }).partial;
		if (partial) message = partial;
		progression.push(message?.usage?.output ?? -1);
	}
	return progression;
}

describe("openai-completions incremental output-token estimate", () => {
	beforeEach(() => {
		mockState.chunks = [];
		vi.stubEnv("OPENAI_API_KEY", "test-key");
	});

	it("grows while streaming text-only deltas before any usage chunk", async () => {
		mockState.chunks = [
			chunk({ content: "Hello beautiful world" }),
			chunk({ content: " and more words" }),
			// finish without any usage chunk (usage-less servers)
			{
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		];
		const progression = await collectOutputProgression();
		// Estimate appears after the first content delta and never decreases.
		expect(progression.length).toBeGreaterThan(1);
		expect(progression[0]).toBeGreaterThan(0);
		for (let i = 1; i < progression.length; i++) {
			expect(progression[i]).toBeGreaterThanOrEqual(progression[i - 1]!);
		}
		// ~4 chars per token: 44 streamed chars -> at most 11 tokens.
		expect(progression.at(-1)).toBeLessThanOrEqual(11);
	});

	it("counts thinking and tool-call deltas too", async () => {
		mockState.chunks = [
			chunk({ reasoning_content: "thinking hard about this problem" }),
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"path":"x"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
			},
			{
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			},
		];
		const progression = await collectOutputProgression();
		expect(progression.at(-1)!).toBeGreaterThanOrEqual(8); // 33 chars -> 9 tokens
	});

	it("final usage chunk overwrites the estimate with exact counts", async () => {
		mockState.chunks = [
			chunk({ content: "Hello beautiful world" }),
			{
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 42, total_tokens: 52 },
			},
		];
		const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
		const result = await stream.result();
		expect(result.usage.output).toBe(42);
	});
});
