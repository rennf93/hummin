import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

function fakeModel(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "model-id",
		name: "Model",
		api: "openai-responses",
		provider: "google",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	} as Model<Api>;
}

function fakeRuntime(models: Model<Api>[]): ModelRuntime {
	return {
		getError: () => undefined,
		getAvailable: async () => models,
	} as unknown as ModelRuntime;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("listModels", () => {
	test("prints JSON when options.json is set", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const runtime = fakeRuntime([
			fakeModel({
				id: "a",
				provider: "google",
				contextWindow: 1_000_000,
				reasoning: true,
				input: ["text", "image"],
			}),
			fakeModel({ id: "b", provider: "openai", contextWindow: 128_000 }),
		]);

		await listModels(runtime, undefined, undefined, { json: true });

		expect(spy).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual({
			provider: "google",
			id: "a",
			name: "Model",
			contextWindow: 1_000_000,
			maxTokens: 8_192,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(parsed[1].reasoning).toBe(false);
	});

	test("prints an empty array for no matches when json is set", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const runtime = fakeRuntime([]);

		await listModels(runtime, "does-not-match", undefined, { json: true });

		expect(spy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual([]);
	});

	test("still renders the human table when json is not requested", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const runtime = fakeRuntime([fakeModel({ id: "a", provider: "google" })]);

		await listModels(runtime, undefined, undefined);

		const output = spy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("provider");
		expect(output).toContain("a");
		expect(spy).toHaveBeenCalled();
	});
});
