import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import humminLocalExtension from "../extensions/hummin-local.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { FLEET_ENGINES, isFleetModel, isFleetProviderId } from "../src/core/fleet-provider-ids.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness } from "./suite/harness.ts";

const model = (provider: string, extra: object = {}): Model<any> => ({ provider, id: "m", ...extra }) as Model<any>;

describe("hummin fleet predicates", () => {
	it("recognizes fleet models by humminHost", () => {
		expect(isFleetModel(model("llamacpp-mac-9991", { humminHost: "Mac" }))).toBe(true);
		expect(isFleetModel(model("colibri-mac-9997", { humminHost: "Mac" }))).toBe(true);
		expect(isFleetModel(model("zai"))).toBe(false);
		expect(isFleetModel(model("llamacpp-cloud-1"))).toBe(false);
	});

	it("recognizes fleet provider ids by the hummin-local format", () => {
		expect(isFleetProviderId("llamacpp-mac-9991")).toBe(true);
		expect(isFleetProviderId("colibri-nas-9997")).toBe(true);
		expect(isFleetProviderId("zai")).toBe(false);
		expect(isFleetProviderId("openrouter")).toBe(false);
		expect(isFleetProviderId("hummin")).toBe(false);
		// id-only path cannot see humminHost, so a cloud provider with the same shape matches
		expect(isFleetProviderId("llamacpp-cloud-1")).toBe(true);
	});

	it("keeps the engine list in sync with hummin-local", () => {
		const source = readFileSync(new URL("../extensions/hummin-local.ts", import.meta.url), "utf8");
		const engines = /ENGINE_NAMES: Record<string, string> = \{([^}]*)\}/
			.exec(source)![1]!
			.split(",")
			.map((entry) => entry.split(":")[0]!.trim())
			.filter(Boolean);
		expect([...FLEET_ENGINES].sort()).toEqual(engines.sort());
	});
});

describe("model selector fleet curation", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("sorts fleet models ahead of other providers", async () => {
		const harness = await createHarness();
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			harness.getModel()!,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const item = (provider: string, extra: object = {}) => ({ provider, id: "m", model: model(provider, extra) });
		const sorted = (selector as unknown as { sortModels(items: unknown[]): Array<{ provider: string }> }).sortModels([
			item("anthropic"),
			item("colibri-mac-9997", { humminHost: "Mac" }),
			item("llamacpp-mac-9991", { humminHost: "Mac" }),
		]);
		expect(sorted.map((entry) => entry.provider)).toEqual(["colibri-mac-9997", "llamacpp-mac-9991", "anthropic"]);
		selector.dispose();
		harness.cleanup();
	});
});

describe("interactive mode fleet curation", () => {
	it("ctrl+P/N curated scope is the fleet models plus zai", async () => {
		const models = [
			model("colibri-mac-9997", { humminHost: "Mac" }),
			model("llamacpp-nas-9991", { humminHost: "NAS" }),
			model("zai"),
			model("openrouter"),
		];
		const fakeThis = {
			session: { modelRuntime: { getAvailableSnapshot: () => models, listCredentials: async () => [] } },
		};
		const curatedModelScope = (
			InteractiveMode as unknown as {
				prototype: { curatedModelScope(this: typeof fakeThis): Promise<Array<{ model: Model<any> }>> };
			}
		).prototype.curatedModelScope;
		const scope = await curatedModelScope.call(fakeThis);
		expect(scope.map((entry) => entry.model.provider)).toEqual(["colibri-mac-9997", "llamacpp-nas-9991", "zai"]);
	});

	it("provider list shows fleet providers without status but hides uncurated cloud ones", () => {
		const provider = (id: string) => ({ id, name: id, auth: { apiKey: {} } });
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => ["openrouter", "llamacpp-mac-9991", "colibri-mac-9997"].map(provider),
					getProviderAuthStatus: () => ({ configured: false }),
					isUsingOAuth: () => false,
				},
			},
			settingsManager: { getProvidersShowAll: () => false },
		};
		const getLoginProviderOptions = (
			InteractiveMode as unknown as {
				prototype: { getLoginProviderOptions(this: typeof fakeThis): Array<{ id: string }> };
			}
		).prototype.getLoginProviderOptions;
		expect(getLoginProviderOptions.call(fakeThis).map((option) => option.id)).toEqual([
			"colibri-mac-9997",
			"llamacpp-mac-9991",
		]);
	});
});

describe("hummin-local through the model runtime", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("keeps humminHost on models in the available snapshot", async () => {
		vi.stubEnv("HUMMIN_FLEET_HEALTH_FILE", join(mkdtempSync(join(tmpdir(), "fleet-ids-")), "health.json"));
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19992");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) =>
				String(input).endsWith("/v1/models")
					? new Response(JSON.stringify({ data: [{ id: "some-model" }] }), { status: 200 })
					: new Response("{}", { status: 404 }),
			),
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		await humminLocalExtension({
			registerProvider: (p: Provider) => registry.registerProvider(p),
			on: () => () => {},
		} as unknown as ExtensionAPI);

		await registry.refresh();
		const fleet = getModelRuntime(registry)
			.getAvailableSnapshot()
			.filter((m) => m.provider.startsWith("llamacpp-"));
		expect(fleet.length).toBeGreaterThan(0);
		expect(fleet.every(isFleetModel)).toBe(true);
	});
});
