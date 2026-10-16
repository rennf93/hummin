/**
 * Fork contract: a model id served by several hummin fleet servers resolves to
 * the first server in fleet order. hummin-local registers one provider per
 * engine + host + port (in fleet.servers order), so the same id appears on
 * several providers by design; upstream reports that as ambiguous.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import humminLocalExtension from "../extensions/hummin-local.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { resolveCliModel, resolveModelScopeFromModels } from "../src/core/model-resolver.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, openAICompletionsApi: () => ({ stream: vi.fn(), streamSimple: vi.fn() }) };
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function fleetModel(provider: string, humminHost: string, id = "qwen3-coder-30b"): Model<Api> {
	return {
		id,
		name: `${id} [${humminHost}]`,
		api: "openai-completions",
		provider,
		baseUrl: `http://${humminHost.toLowerCase()}.local:8080/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 32768,
		humminHost,
	} as Model<Api>;
}

// Fleet order: NAS first, then Mac.
const fleet = [fleetModel("llamacpp-nas-8080", "NAS"), fleetModel("colibri-mac-8081", "Mac")];
const modelRuntime = {
	getModels: () => fleet,
	hasConfiguredAuth: () => true,
} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

describe("hummin fleet model resolution", () => {
	test("--model <exact id> picks the first fleet server", () => {
		const result = resolveCliModel({ cliModel: "qwen3-coder-30b", modelRuntime });
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("llamacpp-nas-8080");
	});

	test("--model <partial id> picks the first fleet server", () => {
		const result = resolveCliModel({ cliModel: "qwen3-coder", modelRuntime });
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("llamacpp-nas-8080");
	});

	test("an enabledModels pattern scopes only the first fleet server", () => {
		const result = resolveModelScopeFromModels(["qwen3-coder-30b"], fleet);
		expect(result.scopedModels.map((scoped) => scoped.model.provider)).toEqual(["llamacpp-nas-8080"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("the same id on a fleet server and a cloud provider stays ambiguous", () => {
		const cloud = { ...fleet[1]!, provider: "openrouter" } as Model<Api> & { humminHost?: string };
		delete cloud.humminHost;
		const mixedRuntime = {
			getModels: () => [fleet[0]!, cloud],
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({ cliModel: "qwen3-coder-30b", modelRuntime: mixedRuntime });
		expect(result.model).toBeUndefined();
		expect(result.error).toContain("ambiguous across providers");
	});

	test("hummin-local registration through the model runtime keeps fleet order, not port order", async () => {
		vi.stubEnv("HUMMIN_FLEET_HEALTH_FILE", join(mkdtempSync(join(tmpdir(), "hummin-fleet-order-")), "health.json"));
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19992,http://127.0.0.1:19991");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) =>
				String(input).endsWith("/v1/models")
					? new Response(JSON.stringify({ data: [{ id: "same-model" }] }), { status: 200 })
					: new Response("{}", { status: 404 }),
			),
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		await humminLocalExtension({
			registerProvider: (provider: Provider) => registry.registerProvider(provider),
			on: () => () => {},
		} as unknown as ExtensionAPI);

		const result = resolveCliModel({ cliModel: "same-model", modelRuntime: getModelRuntime(registry) });
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("llamacpp-127.0.0.1-19992");
	});
});
