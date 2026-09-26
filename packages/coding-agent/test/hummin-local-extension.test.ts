import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminLocalExtension, { DISCOVERY_TTL_MS } from "../extensions/hummin-local.ts";
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
	getModels(): readonly { id: string; contextWindow: number; maxTokens: number; name: string; baseUrl: string }[];
}

function fakeApi(providers: RegisteredProvider[]): ExtensionAPI {
	return {
		registerProvider: (provider: RegisteredProvider) => providers.push(provider),
		// The extension subscribes to session_start to capture ui.notify; tests
		// never fire the event, so an unregisterable no-op subscription is enough.
		on: () => () => {},
	} as unknown as ExtensionAPI;
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

beforeEach(() => {
	// Fleet health must never touch the real agent dir: point every test at a
	// fresh temp file so persisted state from one test cannot leak into another.
	vi.stubEnv("HUMMIN_FLEET_HEALTH_FILE", join(mkdtempSync(join(tmpdir(), "hummin-fleet-test-")), "fleet-health.json"));
});

describe("hummin local provider fleet discovery", () => {
	it("does not invent offline models when discovery is unavailable", async () => {
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19991");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const providers: RegisteredProvider[] = [];

		await humminLocalExtension(fakeApi(providers));

		expect(providers).toHaveLength(0);
	});

	it("uses the configured context fallback and preserves host and port identity", async () => {
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19991,http://127.0.0.1:19992");
		const fetchMock = vi.fn((input: string | URL): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "same-model" }] }));
			return Promise.resolve(response({}, 404));
		});
		vi.stubGlobal("fetch", fetchMock);
		const providers: RegisteredProvider[] = [];

		await humminLocalExtension(fakeApi(providers));

		expect(providers.map((provider) => provider.id)).toEqual([
			"llamacpp-127.0.0.1-19991",
			"llamacpp-127.0.0.1-19992",
		]);
		expect(providers.map((provider) => provider.getModels()[0]?.contextWindow)).toEqual([16384, 16384]);
		expect(providers.map((provider) => provider.getModels()[0]?.maxTokens)).toEqual([16384, 16384]);
		expect(providers[0]?.getModels()[0]?.baseUrl).toBe("http://127.0.0.1:19991/v1");
	});

	it("labels explicit fleet catalog models as offline", async () => {
		// Env overrides fleet; clear it so the mocked fleet config is actually used.
		vi.stubEnv("HUMMIN_INSTANCES", "");
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

		await humminLocalExtension(fakeApi(providers));

		expect(providers.map((provider) => provider.id)).toEqual(["llamacpp-test-19993"]);
		const model = providers[0]?.getModels()[0];
		expect(model?.name).toBe("explicit-model [Test] (offline - start from menubar)");
		expect(model?.contextWindow).toBe(4096);
	});

	it("caches fleet discovery within the TTL so repeated factory runs skip the network", async () => {
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19994");
		const fetchMock = vi.fn((input: string | URL): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "cached-model" }] }));
			return Promise.resolve(response({}, 404));
		});
		vi.stubGlobal("fetch", fetchMock);

		const first: RegisteredProvider[] = [];
		const second: RegisteredProvider[] = [];
		await humminLocalExtension(fakeApi(first));
		await humminLocalExtension(fakeApi(second));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(first.map((provider) => provider.getModels()[0]?.id)).toEqual(["cached-model"]);
		expect(second.map((provider) => provider.getModels()[0]?.id)).toEqual(["cached-model"]);
	});

	it("re-discovers after the TTL expires", async () => {
		const nowSpy = vi.spyOn(Date, "now");
		let now = 1_000_000;
		nowSpy.mockImplementation(() => now);
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19995");
		const fetchMock = vi.fn((input: string | URL): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "ttl-model" }] }));
			return Promise.resolve(response({}, 404));
		});
		vi.stubGlobal("fetch", fetchMock);

		await humminLocalExtension(fakeApi([]));
		now += DISCOVERY_TTL_MS + 1;
		await humminLocalExtension(fakeApi([]));

		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});
