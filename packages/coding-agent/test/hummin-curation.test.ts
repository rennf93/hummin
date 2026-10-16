import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ensureCuratedModelScope } from "../src/core/hummin-curation.ts";

const model = (provider: string) => ({ provider, id: "m" }) as Model<Api>;

const fakeSession = (scopedModels: unknown[], models: Model<Api>[]) => {
	const setScopedModels = vi.fn();
	const session = {
		scopedModels,
		setScopedModels,
		modelRuntime: { getAvailableSnapshot: () => models, listCredentials: async () => [] },
	};
	return { session: session as never, setScopedModels };
};

describe("ensureCuratedModelScope", () => {
	it("sets the curated scope when none is set", async () => {
		const { session, setScopedModels } = fakeSession([], [model("zai"), model("openrouter")]);
		await ensureCuratedModelScope(session);
		expect(setScopedModels).toHaveBeenCalledWith([{ model: expect.objectContaining({ provider: "zai" }) }]);
	});

	it("does not set an empty curated scope", async () => {
		const { session, setScopedModels } = fakeSession([], [model("openrouter")]);
		await ensureCuratedModelScope(session);
		expect(setScopedModels).not.toHaveBeenCalled();
	});

	it("leaves an existing scope alone", async () => {
		const { session, setScopedModels } = fakeSession([{ model: model("openrouter") }], [model("zai")]);
		await ensureCuratedModelScope(session);
		expect(setScopedModels).not.toHaveBeenCalled();
	});
});
