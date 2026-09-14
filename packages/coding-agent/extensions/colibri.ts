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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BUSY_RETRIES = 5;
const BUSY_BASE_DELAY_MS = 2000;
const BUSY_MAX_DELAY_MS = 30000;

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ColibriModelInfo {
	id: string;
}

function parseInstances(): string[] {
	const raw = process.env.HUMMIN_COLIBRI_INSTANCES ?? "http://127.0.0.1:9998,http://127.0.0.1:9997";
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
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
	"qwen3.8-27b": "Qwen 3.8 27B - llama.cpp GGUF",
	"glm-5.3-flash": "GLM 5.3 Flash - llama.cpp GGUF (unsloth)",
	"glm-5.3": "GLM 5.3 - llama.cpp GGUF (unsloth)",
	"kimi-k3": "Kimi K3 - llama.cpp GGUF (unsloth)",
	"glm-5.3-flash-colibri": "GLM 5.3 Flash - colibri int4 container",
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

	// One model namespace across all servers: the first instance in the list
	// that serves a model wins (instance order is preference order). Context
	// windows come from each server's own /props when available.
	const serving = new Map<string, { baseUrl: string; contextWindow: number }>();
	const discovered = await Promise.allSettled(
		instances.map(async (baseUrl) => {
			const [ids, contextWindow] = await Promise.all([
				fetchModels(baseUrl, process.env.COLI_API_KEY),
				fetchContextWindow(baseUrl, process.env.COLI_API_KEY),
			]);
			return { baseUrl, ids, contextWindow };
		}),
	);
	for (const result of discovered) {
		if (result.status !== "fulfilled") continue;
		for (const modelId of result.value.ids) {
			if (!serving.has(modelId)) {
				serving.set(modelId, { baseUrl: result.value.baseUrl, contextWindow: result.value.contextWindow });
			}
		}
	}
	// Catalog fill-in: staged-but-off servers still get their known models
	// listed (marked by their known context window until the server comes up
	// and a fresh session reads /props). Generation against an off server
	// fails with connection refused - start it from the menubar.
	for (const entry of MODEL_CATALOG) {
		if (serving.has(entry.id)) continue;
		const baseUrl = instances.find((url) => {
			try {
				const hostname = new URL(url).hostname;
				return LAN_HOSTS.has(hostname) && hostname === entry.host && instancePort(url) === entry.port;
			} catch {
				return false;
			}
		});
		if (baseUrl) {
			serving.set(entry.id, { baseUrl, contextWindow: entry.contextWindow });
		}
	}
	if (serving.size === 0) {
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
	const models: Model<"openai-completions">[] = [...serving.entries()].map(([modelId, served]) => ({
		id: modelId,
		name: displayName(modelId),
		api: "openai-completions",
		provider: "colibri",
		baseUrl: `${served.baseUrl}/v1`,
		reasoning: isQwenFamily(modelId),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: served.contextWindow,
		maxTokens: 4096,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			...(isQwenFamily(modelId) ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		},
	}));

	const provider = createProvider({
		id: "colibri",
		name: `Colibri (${serving.size} model${serving.size === 1 ? "" : "s"})`,
		baseUrl: `${instances[0]}/v1`,
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
