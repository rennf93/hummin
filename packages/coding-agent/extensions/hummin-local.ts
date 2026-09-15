/** Fleet-driven, per-engine/host providers. Local requests share an abortable
 * process lock through the end of the stream. Discovery never invents IDs. */
import { setTimeout as delay } from "node:timers/promises";
import {
	type Api,
	type ApiKeyAuth,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	envApiKeyAuth,
	type Model,
	openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, SettingsManager, withLocalInferenceLock } from "@earendil-works/pi-coding-agent";

type FleetServerSettings = ReturnType<SettingsManager["getFleetServers"]>[number];

const MAX_BUSY_RETRIES = 5;
const BUSY_BASE_DELAY_MS = 2000;
const BUSY_MAX_DELAY_MS = 30000;

interface LocalModelInfo {
	id: string;
}

/** Metadata consumed by the interactive model picker. Kept outside pi-ai's
 * shared Model type so this fork does not alter the upstream API. */
interface HumminModelMetadata {
	humminHost?: string;
	humminOffline?: boolean;
}

interface InstanceConfig {
	id: string;
	baseUrl: string;
	host: string;
	hostLabel: string;
	port: number;
	engine: "colibri" | "llamacpp";
	models?: Array<{ id: string; contextWindow: number }>;
}

const DISPLAY_NAMES: Record<string, string> = {
	"qwen3.8-27b": "Qwen 3.8 27B",
	"glm-5.3-flash": "GLM 5.3 Flash",
	"glm-5.3": "GLM 5.3",
	"kimi-k3": "Kimi K3",
	"glm-5.3-flash-local": "GLM 5.3 Flash (int4)",
};
const displayName = (modelId: string): string => DISPLAY_NAMES[modelId] ?? modelId;

function instanceConfigs(): InstanceConfig[] {
	const settings = SettingsManager.create(process.cwd());
	const fleet = typeof settings.getFleetServers === "function" ? settings.getFleetServers() : [];
	const env = process.env.HUMMIN_INSTANCES?.trim() ?? process.env.HUMMIN_COLIBRI_INSTANCES?.trim();
	if (env) {
		return env
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean)
			.map((baseUrl) => {
				const url = new URL(baseUrl);
				return {
					id: baseUrl,
					baseUrl,
					host: url.hostname,
					hostLabel: url.hostname,
					port: instancePort(baseUrl),
					engine: "llamacpp",
				};
			});
	}
	if (fleet.length > 0) return fleet.map((server) => configFromFleet(server));
	return settings.getLocalInstances().map((baseUrl) => {
		const url = new URL(baseUrl);
		return {
			id: baseUrl,
			baseUrl,
			host: url.hostname,
			hostLabel: url.hostname,
			port: instancePort(baseUrl),
			engine: "llamacpp",
		};
	});
}

function configFromFleet(server: FleetServerSettings): InstanceConfig {
	return {
		id: server.id,
		baseUrl: `http://${server.hostIp}:${server.port}`,
		host: server.hostIp,
		hostLabel: server.host ?? server.hostIp,
		port: server.port,
		engine: server.engine ?? "llamacpp",
		models: server.models,
	};
}

async function fetchModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	const response = await fetch(`${baseUrl}/v1/models`, {
		signal: AbortSignal.timeout(5000),
		headers: { Authorization: `Bearer ${apiKey ?? "hummin"}` },
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${baseUrl}/v1/models`);
	}
	const body = (await response.json()) as { data?: LocalModelInfo[] };
	return (body.data ?? []).map((entry) => entry.id).filter((id) => typeof id === "string" && id.length > 0);
}

// llama.cpp servers report their real context window on /props; hummin docker does
// not serve that endpoint. Used as a per-model contextWindow override so the
// advertised window matches what the server actually accepts.
async function fetchContextWindow(baseUrl: string, apiKey: string | undefined): Promise<number | null> {
	try {
		const response = await fetch(`${baseUrl}/props`, {
			signal: AbortSignal.timeout(3000),
			headers: { Authorization: `Bearer ${apiKey ?? "hummin"}` },
		});
		if (!response.ok) return null;
		const body = (await response.json()) as {
			default_generation_settings?: { n_ctx?: number };
			n_ctx?: number;
		};
		const nCtx = body.default_generation_settings?.n_ctx ?? body.n_ctx;
		return typeof nCtx === "number" && nCtx > 0 ? Math.floor(nCtx) : null;
	} catch {
		return null;
	}
}

export function serializedLocalStream(
	model: Model<Api>,
	signal: AbortSignal | undefined,
	streamFactory: (signal: AbortSignal) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const events = createAssistantMessageEventStream();
	void withLocalInferenceLock(model.baseUrl, signal, async (lockedSignal) => {
		for (let attempt = 0; ; attempt++) {
			lockedSignal.throwIfAborted();
			if (attempt)
				await delay(Math.min(BUSY_BASE_DELAY_MS * attempt, BUSY_MAX_DELAY_MS), undefined, { signal: lockedSignal });
			let retry = false;
			let emittedContent = false;
			for await (const event of streamFactory(lockedSignal)) {
				if (
					event.type === "error" &&
					!emittedContent &&
					attempt < MAX_BUSY_RETRIES &&
					/\b429\b|\bbusy\b|\boverloaded\b/i.test(event.error.errorMessage ?? "")
				) {
					retry = true;
					break;
				}
				if (event.type !== "start" && event.type !== "error") emittedContent = true;
				events.push(event);
				if (event.type === "done" || event.type === "error") return;
			}
			if (!retry) throw new Error("Local provider stream ended without a terminal event");
		}
	}).catch((error: unknown) => {
		const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			stopReason: aborted ? "aborted" : "error",
			errorMessage: String(error),
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		events.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
	});
	return events;
}

const localAuth = (): ApiKeyAuth => ({
	...envApiKeyAuth("Hummin API key", ["HUMMIN_API_KEY"]),
	// Keyless LAN instances are always configured: resolve falls back to a
	// placeholder key that local servers ignore without an API key.
	resolve: async ({ credential }) => {
		const key = credential?.key ?? process.env.COLI_API_KEY;
		return { auth: { apiKey: key ?? "hummin" }, source: credential?.key ? "stored credential" : "default" };
	},
});

// qwen-family chat templates take enable_thinking via chat_template_kwargs
// (llama.cpp applies it per request); other model families register without
// thinking controls rather than sending them kwargs of unknown meaning.
function isQwenFamily(modelId: string): boolean {
	return /^qwen/i.test(modelId);
}

// Per-engine, per-host providers: the footer and picker badges must say
// WHICH engine (colibri container vs unsloth/llama.cpp GGUF) and WHICH host
// (Mac/NAS) serves a model - a single local provider hid both.
function instancePort(baseUrl: string): number {
	const match = baseUrl.match(/:(\d+)\/?$/);
	return match ? Number(match[1]) : 0;
}

// Picker display names: id stays the stable identifier, the name says what
// actually serves it (engine + format), because "[hummin]" is the provider
// label for all of them and tells the user nothing about the model itself.
export default async function humminLocalExtension(pi: ExtensionAPI): Promise<void> {
	const configs = instanceConfigs();
	const instances = configs.map((config) => config.baseUrl);
	if (instances.length === 0) {
		return;
	}

	// Per-instance model discovery: no cross-host dedupe - each host is a
	// distinct, explicitly selectable endpoint (engine + host are visible).
	const serving: Array<{
		modelId: string;
		baseUrl: string;
		host: string;
		port: number;
		engine: "colibri" | "llamacpp";
		contextWindow: number;
		offline: boolean;
	}> = [];
	const discovered = await Promise.allSettled(
		instances.map(async (baseUrl) => {
			const [ids, contextWindow] = await Promise.all([
				fetchModels(baseUrl, process.env.COLI_API_KEY),
				fetchContextWindow(baseUrl, process.env.COLI_API_KEY),
			]);
			return { baseUrl, ids, contextWindow: contextWindow ?? Number(process.env.HUMMIN_CTX ?? process.env.HUMMIN_COLIBRI_CTX ?? 16384) };
		}),
	);
	const instanceMeta = new Map(
		instances.map((baseUrl) => {
			const config = configs.find((entry) => entry.baseUrl === baseUrl)!;
			return [baseUrl, config];
		}),
	);
	for (const result of discovered) {
		if (result.status !== "fulfilled") continue;
		const meta = instanceMeta.get(result.value.baseUrl)!;
		for (const modelId of result.value.ids) {
			serving.push({
				modelId,
				baseUrl: result.value.baseUrl,
				host: meta.hostLabel,
				port: meta.port,
				engine: meta.engine,
				contextWindow: result.value.contextWindow,
				offline: false,
			});
		}
	}
	// Catalog fill-in: staged-but-off servers still get their configured models
	// listed (with their known context window until the server comes up and a
	// fresh session reads /props). Generation against an off server fails
	// with connection refused - start it from the menubar.
	for (const config of configs) {
		for (const entry of config.models ?? []) {
			const already = serving.some((entry2) => entry2.modelId === entry.id && entry2.baseUrl === config.baseUrl);
			if (already) continue;
			serving.push({
				modelId: entry.id,
				baseUrl: config.baseUrl,
				host: config.hostLabel,
				port: config.port,
				engine: config.engine,
				contextWindow: entry.contextWindow,
				offline: true,
			});
		}
	}
	if (serving.length === 0) {
		return;
	}

	const base = openAICompletionsApi();

	// Group by engine + host: one provider per combination so badges read
	// e.g. "unsloth/llama.cpp - NAS" and "hummin - Mac".
	const ENGINE_NAMES: Record<string, string> = { colibri: "colibri", llamacpp: "unsloth/llama.cpp" };
	const groups = new Map<string, { engine: string; host: string; entries: typeof serving }>();
	for (const entry of serving) {
		const key = `${entry.engine}-${entry.host}-${entry.port}`;
		let group = groups.get(key);
		if (!group) {
			group = { engine: entry.engine, host: entry.host, entries: [] };
			groups.set(key, group);
		}
		group.entries.push(entry);
	}

	for (const group of groups.values()) {
		const hostLabel = group.host;
		const providerId = `${group.engine}-${hostLabel.toLowerCase()}-${group.entries[0]!.port}`;
		const providerName = `${ENGINE_NAMES[group.engine]} - ${hostLabel}:${group.entries[0]!.port}`;
		const models: Model<"openai-completions">[] = group.entries.map(
			(entry) =>
				({
					id: entry.modelId,
					name: `${displayName(entry.modelId)} [${hostLabel}]${entry.offline ? " (offline - start from menubar)" : ""}`,
					api: "openai-completions",
					provider: providerId,
					baseUrl: `${entry.baseUrl}/v1`,
					reasoning: isQwenFamily(entry.modelId),
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: entry.contextWindow,
					maxTokens: 4096,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						maxTokensField: "max_tokens",
						...(isQwenFamily(entry.modelId) ? { thinkingFormat: "qwen-chat-template" as const } : {}),
					},
					// The picker uses these optional fields for styling. They survive the
					// provider/model runtime because models are passed by reference.
					humminHost: hostLabel,
					humminOffline: entry.offline,
				}) as Model<"openai-completions"> & HumminModelMetadata,
		);
		const provider = createProvider({
			id: providerId,
			name: providerName,
			baseUrl: `${group.entries[0]!.baseUrl}/v1`,
			auth: { apiKey: localAuth() },
			models,
			api: {
				stream: (model, context, options) =>
					serializedLocalStream(model, options?.signal, (signal) =>
						base.stream(model, context, { ...options, signal }),
					),
				streamSimple: (model, context, options) =>
					serializedLocalStream(model, options?.signal, (signal) =>
						base.streamSimple(model, context, { ...options, signal }),
					),
			},
		});
		pi.registerProvider(provider);
	}
}
