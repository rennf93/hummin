/**
 * hummin-colibri: registers ONE provider ("colibri") that exposes every
 * model found on the configured local inference servers. The servers are
 * OpenAI-compatible endpoints on the LAN; the engine behind them does not
 * matter (colibri, llama.cpp, Ollama, ...). Selection is by model id, not by
 * server: each discovered model is served by the first instance in
 * HUMMIN_COLIBRI_INSTANCES that lists it, so the same model on several
 * machines deduplicates into one picker entry with fallback ordering.
 *
 * Configure instances with the HUMMIN_COLIBRI_INSTANCES environment variable
 * (comma-separated base URLs). Defaults to two local instances, which also
 * matches scripts/mock-colibri.mjs for testing without a NAS:
 *
 *   HUMMIN_COLIBRI_INSTANCES="http://127.0.0.1:9998,http://127.0.0.1:9997"
 *
 * Optional environment variables:
 *   COLI_API_KEY       bearer token forwarded to the server. Keyless instances
 *                      work without it (a placeholder key is sent and ignored);
 *                      set it when the server runs with COLI_API_KEY enforced.
 *   HUMMIN_COLIBRI_CTX  advertised context window per model (default: 16384).
 *
 * A model is only listed while its server answers at session start; a server
 * that comes back later needs a session restart to reappear. There are no
 * guessed placeholder ids - a stale guess used to display the wrong model
 * family for a slot that served something else.
 *
 * Per-model reasoning: qwen-family chat templates accept
 * chat_template_kwargs.enable_thinking (llama.cpp applies it), so qwen*
 * models map hummin's thinking level onto it ("off" => false, any other
 * level => true). Other models (e.g. glm-* via colibri) register without
 * thinking controls.
 *
 * Each colibri instance generates one response at a time. Requests are
 * serialized per server (mutex keyed by base URL) and the documented busy
 * response (HTTP 429 + x-colibri-queue-wait-ms) is retried with capped
 * backoff instead of surfacing as an error.
 */

import {
	createAssistantMessageEventStream,
	createProvider,
	envApiKeyAuth,
	openAICompletionsApi,
	type ApiKeyAuth,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BUSY_RETRIES = 5;
const BUSY_BASE_DELAY_MS = 2000;
const BUSY_MAX_DELAY_MS = 30000;

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ColibriModelInfo {
	id: string;
}

function parseInstances(): string[] {
	// Settings first-class (hummin init), env overrides, documented dev default last.
	const settings = SettingsManager.create(process.cwd());
	return settings.getColibriInstances();
}

async function fetchModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	const response = await fetch(`${baseUrl}/v1/models`, {
		signal: AbortSignal.timeout(5000),
		headers: { Authorization: `Bearer ${apiKey ?? "colibri"}` },
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${baseUrl}/v1/models`);
	}
	const body = (await response.json()) as { data?: ColibriModelInfo[] };
	return (body.data ?? [])
		.map((entry) => entry.id)
		.filter((id) => typeof id === "string" && id.length > 0);
}

// llama.cpp servers report their real context window on /props; colibri does
// not serve that endpoint. Used as a per-model contextWindow override so the
// advertised window matches what the server actually accepts.
async function fetchContextWindow(baseUrl: string, apiKey: string | undefined): Promise<number | null> {
	try {
		const response = await fetch(`${baseUrl}/props`, {
			signal: AbortSignal.timeout(3000),
			headers: { Authorization: `Bearer ${apiKey ?? "colibri"}` },
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

function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<void> = Promise.resolve();
	return <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(task, task);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

function isBusy(error: AssistantMessage): boolean {
	const text = `${error.errorMessage ?? ""} ${error.stopReason ?? ""}`;
	return /\b429\b/.test(text) || /\bbusy\b/i.test(text) || /\boverloaded\b/i.test(text);
}

// Serializes requests through one instance and retries colibri's busy
// response (429 + x-colibri-queue-wait-ms) with capped backoff instead of
// surfacing it as an error to the agent loop.
function retrying(streamFactory: () => AssistantMessageEventStream): AssistantMessageEventStream {
	const events = createAssistantMessageEventStream();
	void (async () => {
		for (let attempt = 0; ; attempt++) {
			if (attempt > 0) {
				await sleep(Math.min(BUSY_BASE_DELAY_MS * attempt, BUSY_MAX_DELAY_MS));
			}
			let busyRetry = false;
			let terminal = false;
			for await (const event of streamFactory()) {
				if (event.type === "error" && isBusy(event.error) && attempt < MAX_BUSY_RETRIES) {
					busyRetry = true;
					break;
				}
				if (event.type === "done" || event.type === "error") {
					terminal = true;
				}
				events.push(event);
			}
			if (terminal || !busyRetry) {
				return;
			}
		}
	})();
	return events;
}

const colibriAuth = (): ApiKeyAuth => ({
	...envApiKeyAuth("Colibri API key", ["COLI_API_KEY"]),
	// Keyless LAN instances are always configured: resolve falls back to a
	// placeholder key that colibri ignores when it runs without COLI_API_KEY.
	resolve: async ({ credential }) => {
		const key = credential?.key ?? process.env.COLI_API_KEY;
		return { auth: { apiKey: key ?? "colibri" }, source: credential?.key ? "stored credential" : "default" };
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
// (Mac/NAS) serves a model - a single "colibri" provider hid both.
const HOST_LABELS: Record<string, string> = {
	"192.168.50.111": "NAS",
	"192.168.50.199": "Mac",
};

function engineFor(host: string, port: number): "colibri" | "llamacpp" {
	if (host === "192.168.50.111" && port === 9998) return "colibri";
	if (host === "192.168.50.199" && port === 9997) return "colibri";
	return "llamacpp";
}

function parseHost(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return "";
	}
}

// Staged-model catalog: models OUR servers serve, kept visible in the picker
// even while their server is off (the fleet is on-demand). Only applies to
// the LAN hosts and only fills models discovery did not already return, so a
// live server's real /v1/models always wins. Aliases must match what the
// servers advertise (--alias flags and colibri's model ids).
const LAN_HOSTS = new Set(["192.168.50.111", "192.168.50.199"]);
const MODEL_CATALOG: Array<{ id: string; host: string; port: number; contextWindow: number }> = [
	{ id: "qwen3.8-27b", host: "192.168.50.199", port: 9998, contextWindow: 131072 },  // Mac llama.cpp
	{ id: "qwen3.8-27b", host: "192.168.50.111", port: 9996, contextWindow: 262144 },  // NAS llama.cpp
	{ id: "glm-5.3-flash-colibri", host: "192.168.50.111", port: 9998, contextWindow: 32768 }, // NAS colibri
	{ id: "glm-5.3-flash-colibri", host: "192.168.50.199", port: 9997, contextWindow: 32768 }, // Mac colibri (staged)
	{ id: "glm-5.3-flash", host: "192.168.50.199", port: 9995, contextWindow: 65536 },  // Mac unsloth fork
	{ id: "glm-5.3-flash", host: "192.168.50.111", port: 9995, contextWindow: 262144 }, // NAS unsloth fork
	{ id: "glm-5.3", host: "192.168.50.111", port: 9994, contextWindow: 262144 },       // NAS unsloth fork
	{ id: "kimi-k3", host: "192.168.50.111", port: 9993, contextWindow: 1048576 },      // NAS unsloth fork
];

function instancePort(baseUrl: string): number {
	const match = baseUrl.match(/:(\d+)\/?$/);
	return match ? Number(match[1]) : 0;
}

// Picker display names: id stays the stable identifier, the name says what
// actually serves it (engine + format), because "[colibri]" is the provider
// label for all of them and tells the user nothing about the model itself.
const DISPLAY_NAMES: Record<string, string> = {
	"qwen3.8-27b": "Qwen 3.8 27B",
	"glm-5.3-flash": "GLM 5.3 Flash",
	"glm-5.3": "GLM 5.3",
	"kimi-k3": "Kimi K3",
	"glm-5.3-flash-colibri": "GLM 5.3 Flash (int4)",
};

function displayName(modelId: string): string {
	return DISPLAY_NAMES[modelId] ?? modelId;
}

export default async function colibriExtension(pi: ExtensionAPI): Promise<void> {
	const instances = parseInstances();
	if (instances.length === 0) {
		return;
	}
	const contextWindow = Number(process.env.HUMMIN_COLIBRI_CTX ?? 16384);

	// Per-instance model discovery: no cross-host dedupe - each host is a
	// distinct, explicitly selectable endpoint (engine + host are visible).
	const serving: Array<{
		modelId: string;
		baseUrl: string;
		host: string;
		port: number;
		engine: "colibri" | "llamacpp";
		contextWindow: number;
	}> = [];
	const discovered = await Promise.allSettled(
		instances.map(async (baseUrl) => {
			const [ids, contextWindow] = await Promise.all([
				fetchModels(baseUrl, process.env.COLI_API_KEY),
				fetchContextWindow(baseUrl, process.env.COLI_API_KEY),
			]);
			return { baseUrl, ids, contextWindow };
		}),
	);
	const instanceMeta = new Map(
		instances.map((baseUrl) => {
			const host = parseHost(baseUrl);
			return [baseUrl, { host, port: instancePort(baseUrl), engine: engineFor(host, instancePort(baseUrl)) }];
		}),
	);
	for (const result of discovered) {
		if (result.status !== "fulfilled") continue;
		const meta = instanceMeta.get(result.value.baseUrl)!;
		for (const modelId of result.value.ids) {
			serving.push({
				modelId,
				baseUrl: result.value.baseUrl,
				host: meta.host,
				port: meta.port,
				engine: meta.engine,
				contextWindow: result.value.contextWindow,
			});
		}
	}
	// Catalog fill-in: staged-but-off servers still get their known models
	// listed (with their known context window until the server comes up and a
	// fresh session reads /props). Generation against an off server fails
	// with connection refused - start it from the menubar.
	for (const entry of MODEL_CATALOG) {
		const already = serving.some(
			(entry2) => entry2.modelId === entry.id && entry2.host === entry.host && entry2.port === entry.port,
		);
		if (already) continue;
		const baseUrl = instances.find((url) => {
			try {
				const hostname = new URL(url).hostname;
				return LAN_HOSTS.has(hostname) && hostname === entry.host && instancePort(url) === entry.port;
			} catch {
				return false;
			}
		});
		if (baseUrl) {
			serving.push({
				modelId: entry.id,
				baseUrl,
				host: entry.host,
				port: entry.port,
				engine: engineFor(entry.host, entry.port),
				contextWindow: entry.contextWindow,
			});
		}
	}
	if (serving.length === 0) {
		return;
	}

	const mutexes = new Map<string, <T>(task: () => Promise<T>) => Promise<T>>();
	const mutexFor = (baseUrl: string): (<T>(task: () => Promise<T>) => Promise<T>) => {
		let mutex = mutexes.get(baseUrl);
		if (!mutex) {
			mutex = createMutex();
			mutexes.set(baseUrl, mutex);
		}
		return mutex;
	};

	const base = openAICompletionsApi();

	// Group by engine + host: one provider per combination so badges read
	// e.g. "unsloth/llama.cpp - NAS" and "colibri - Mac".
	const ENGINE_NAMES: Record<string, string> = { colibri: "colibri", llamacpp: "unsloth/llama.cpp" };
	const groups = new Map<
		string,
		{ engine: string; host: string; entries: typeof serving }
	>();
	for (const entry of serving) {
		const key = `${entry.engine}-${entry.host}`;
		let group = groups.get(key);
		if (!group) {
			group = { engine: entry.engine, host: entry.host, entries: [] };
			groups.set(key, group);
		}
		group.entries.push(entry);
	}

	for (const [key, group] of groups) {
		const hostLabel = HOST_LABELS[group.host] ?? group.host;
		const providerId = `${group.engine}-${hostLabel.toLowerCase()}`;
		const providerName = `${ENGINE_NAMES[group.engine]} - ${hostLabel}`;
		const models: Model<"openai-completions">[] = group.entries.map((entry) => ({
			id: entry.modelId,
			name: displayName(entry.modelId),
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
		}));
		const provider = createProvider({
			id: providerId,
			name: providerName,
			baseUrl: `${group.entries[0]!.baseUrl}/v1`,
			auth: { apiKey: colibriAuth() },
			models,
			api: {
				stream: (model, context, options) =>
					mutexFor(model.baseUrl)(() => Promise.resolve(retrying(() => base.stream(model, context, options)))),
				streamSimple: (model, context, options) =>
					mutexFor(model.baseUrl)(() => Promise.resolve(retrying(() => base.streamSimple(model, context, options)))),
			},
		});
		pi.registerProvider(provider);
	}
}
