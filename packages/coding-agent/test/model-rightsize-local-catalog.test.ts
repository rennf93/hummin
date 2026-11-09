import { describe, expect, it } from "vitest";
import { buildCatalog, resolveRequestedModel, type ModelLike, type ModelProfile } from "../extensions/lib/model-rightsize.ts";

const profiles: ModelProfile[] = [
	{ provider: "zai", modelId: "glm-5.3-flash", description: "cloud fast" },
	{ provider: "anthropic", modelId: "claude-sonnet-5", description: "cloud strong" },
];

// A registry that mixes paid cloud models with two local/fleet entries. The
// local entries carry `local: true` exactly as the fleet registration does
// (via humminHost/humminOffline on the pi Model).
const registry = (): ModelLike[] => [
	{ provider: "zai", id: "glm-5.3-flash", thinkingLevels: ["off", "low"] },
	{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevels: ["off", "medium"] },
	{ provider: "llamacpp-mac-9992", id: "lfm3-omni-2b", local: true, thinkingLevels: ["off"] },
	{ provider: "llamacpp-nas-egpu-9994", id: "glm-5.3-flash-coder-rco", local: true, thinkingLevels: ["off", "medium"] },
];

describe("buildCatalog with profiles", () => {
	it("keeps paid cloud profiled models and drops unprofiled paid models", () => {
		const catalog = buildCatalog(registry(), profiles);
		const keys = catalog.models.map((m) => `${m.provider}/${m.modelId}`);
		expect(keys).toContain("zai/glm-5.3-flash");
		expect(keys).toContain("anthropic/claude-sonnet-5");
	});

	it("always includes local/fleet models even though they are unprofiled", () => {
		const catalog = buildCatalog(registry(), profiles);
		const keys = catalog.models.map((m) => `${m.provider}/${m.modelId}`);
		expect(keys).toContain("llamacpp-mac-9992/lfm3-omni-2b");
		expect(keys).toContain("llamacpp-nas-egpu-9994/glm-5.3-flash-coder-rco");
	});

	it("resolves an explicit local model id against the profiled catalog", () => {
		const catalog = buildCatalog(registry(), profiles);
		const resolved = resolveRequestedModel("llamacpp-nas-egpu-9994/glm-5.3-flash-coder-rco", catalog);
		expect(resolved.matched).toBe(true);
		expect(resolved.provider).toBe("llamacpp-nas-egpu-9994");
		expect(resolved.modelId).toBe("glm-5.3-flash-coder-rco");
	});
});
