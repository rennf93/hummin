import type * as PiAi from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import colibriExtension from "../extensions/colibri.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		openAICompletionsApi: () => ({ stream: vi.fn(), streamSimple: vi.fn() }),
	};
});

interface RegisteredProvider {
	id: string;
	getModels(): readonly { id: string; contextWindow: number; name: string; baseUrl: string }[];
}

function fakeApi(providers: RegisteredProvider[]): ExtensionAPI {
	return { registerProvider: (provider: RegisteredProvider) => providers.push(provider) } as unknown as ExtensionAPI;
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("hummin colibri fleet discovery", () => {
	it("does not invent offline models when discovery is unavailable", async () => {
		vi.stubEnv("HUMMIN_COLIBRI_INSTANCES", "http://127.0.0.1:19991");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const providers: RegisteredProvider[] = [];

		await colibriExtension(fakeApi(providers));

		expect(providers).toHaveLength(0);
	});

	it("uses the configured context fallback and preserves host and port identity", async () => {
		vi.stubEnv("HUMMIN_COLIBRI_INSTANCES", "http://127.0.0.1:19991,http://127.0.0.1:19992");
		const fetchMock = vi.fn((input: string | URL): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "same-model" }] }));
			return Promise.resolve(response({}, 404));
		});
		vi.stubGlobal("fetch", fetchMock);
		const providers: RegisteredProvider[] = [];

		await colibriExtension(fakeApi(providers));

		expect(providers.map((provider) => provider.id)).toEqual([
			"llamacpp-127.0.0.1-19991",
			"llamacpp-127.0.0.1-19992",
		]);
		expect(providers.map((provider) => provider.getModels()[0]?.contextWindow)).toEqual([16384, 16384]);
		expect(providers[0]?.getModels()[0]?.baseUrl).toBe("http://127.0.0.1:19991/v1");
	});

	it("labels explicit fleet catalog models as offline", async () => {
		// Env overrides fleet; clear it so the mocked fleet config is actually used.
		vi.stubEnv("HUMMIN_COLIBRI_INSTANCES", "");
		vi.spyOn(SettingsManager, "create").mockReturnValue({
			getFleetServers: () => [
				{
					id: "staged",
					label: "Staged",
					host: "Test",
					hostIp: "127.0.0.1",
					port: 19993,
					kind: "docker",
					target: "staged",
					models: [{ id: "explicit-model", contextWindow: 4096 }],
				},
			],
			getColibriInstances: () => [],
		} as unknown as SettingsManager);
		const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
		vi.stubGlobal("fetch", fetchMock);
		const providers: RegisteredProvider[] = [];

		await colibriExtension(fakeApi(providers));

		expect(providers.map((provider) => provider.id)).toEqual(["llamacpp-test-19993"]);
		const model = providers[0]?.getModels()[0];
		expect(model?.name).toBe("explicit-model [Test] (offline - start from menubar)");
		expect(model?.contextWindow).toBe(4096);
	});
});
