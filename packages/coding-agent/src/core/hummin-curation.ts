import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import { isFleetModel, isFleetProviderId } from "./fleet-provider-ids.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const ZAI_PROVIDER_IDS = new Set(["zai", "zai-coding-cn", "zai-api"]);

/** Models ctrl+P/N may land on: fleet models, zai and providers with stored credentials. */
export async function curatedModelScope(
	modelRuntime: Pick<ModelRuntime, "getAvailableSnapshot" | "listCredentials">,
): Promise<Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>> {
	const models = modelRuntime.getAvailableSnapshot();
	const credentials = await modelRuntime.listCredentials({ signal: AbortSignal.timeout(5_000) }).catch(() => []);
	const credentialed = new Set(credentials.map((entry) => entry.providerId));
	return models
		.filter(
			(model) => isFleetModel(model) || ZAI_PROVIDER_IDS.has(model.provider) || credentialed.has(model.provider),
		)
		.map((model) => ({ model }));
}

/**
 * hummin curation: ctrl+P/N walks only curated and credentialed models.
 * Cycling the full 167-model catalog lands on unconfigured providers, which reads as the app being broken.
 */
export async function ensureCuratedModelScope(
	session: Pick<AgentSession, "scopedModels" | "setScopedModels" | "modelRuntime">,
): Promise<void> {
	if (session.scopedModels.length > 0) return;
	const scope = await curatedModelScope(session.modelRuntime);
	if (scope.length > 0) session.setScopedModels(scope);
}

/** Provider list: hide uncurated cloud providers without status unless showAll; curated ones sort first. */
export function curateProviderOptions<T extends { id: string; name: string; status?: unknown }>(
	options: T[],
	showAll: boolean,
): T[] {
	const curated = (id: string): boolean => ZAI_PROVIDER_IDS.has(id) || isFleetProviderId(id);
	const visible = options.filter((option) => showAll || curated(option.id) || option.status !== undefined);
	return visible.sort((a, b) => {
		const aCurated = curated(a.id);
		const bCurated = curated(b.id);
		if (aCurated && !bCurated) return -1;
		if (!aCurated && bCurated) return 1;
		return a.name.localeCompare(b.name);
	});
}
