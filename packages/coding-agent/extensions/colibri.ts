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

export default async function colibriExtension(pi: ExtensionAPI): Promise<void> {
	const instances = parseInstances();
	if (instances.length === 0) {
		return;
	}
	const contextWindow = Number(process.env.HUMMIN_COLIBRI_CTX ?? 16384);

	// One model namespace across all servers: the first instance in the list
	// that serves a model wins (instance order is preference order).
	const serving = new Map<string, string>();
	const discovered = await Promise.allSettled(
		instances.map((baseUrl) => fetchModels(baseUrl, process.env.COLI_API_KEY).then((ids) => ({ baseUrl, ids }))),
	);
	for (const result of discovered) {
		if (result.status !== "fulfilled") continue;
		for (const modelId of result.value.ids) {
			if (!serving.has(modelId)) {
				serving.set(modelId, result.value.baseUrl);
			}
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
	const models: Model<"openai-completions">[] = [...serving.entries()].map(([modelId, baseUrl]) => ({
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: "colibri",
		baseUrl: `${baseUrl}/v1`,
		reasoning: isQwenFamily(modelId),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
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
