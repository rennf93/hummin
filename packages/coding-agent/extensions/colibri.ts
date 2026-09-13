/**
 * hummin-colibri: registers one OpenAI-compatible provider per colibri
 * inference server (https://github.com/JustVugg/colibri) on the LAN.
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
 *   HUMMIN_COLIBRI_CTX  advertised context window per model (default: 16384,
 *                      matching the colibri-flash.service CTX on the NAS).
 *
 * Colibri generates one response at a time per instance. This extension
 * serializes requests per instance and retries the documented busy response
 * (HTTP 429 + x-colibri-queue-wait-ms) with capped backoff instead of
 * surfacing it as an error.
 */

import {
	createAssistantMessageEventStream,
	createProvider,
	envApiKeyAuth,
	openAICompletionsApi,
	type Api,
	type ApiKeyAuth,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
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
function serializeWithBusyRetry(base: ProviderStreams): ProviderStreams {
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

	return {
		stream: (model: Model<Api>, context: Context, options?: StreamOptions) =>
			retrying(() => base.stream(model, context, options)),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			retrying(() => base.streamSimple(model, context, options)),
	};
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

export default async function colibriExtension(pi: ExtensionAPI): Promise<void> {
	const instances = parseInstances();
	if (instances.length === 0) {
		return;
	}
	const contextWindow = Number(process.env.HUMMIN_COLIBRI_CTX ?? 16384);

	for (const [index, rawUrl] of instances.entries()) {
		const baseUrl = rawUrl.replace(/\/+$/, "");
		const id = instances.length === 1 ? "colibri" : `colibri-${index + 1}`;
		await registerInstance(pi, id, baseUrl, contextWindow);
	}
}

async function registerInstance(
	pi: ExtensionAPI,
	id: string,
	baseUrl: string,
	contextWindow: number,
): Promise<void> {
	let modelIds: string[] = [];
	try {
		modelIds = await fetchModels(baseUrl, process.env.COLI_API_KEY);
	} catch {
		// Unreachable instance (server down, host asleep): still register with the
		// documented default model id so the picker always shows colibri entries.
		// Requests fail at generation time until the server is back.
		modelIds = ["glm-5.3-flash-colibri"];
	}
	if (modelIds.length === 0) {
		modelIds = ["glm-5.3-flash-colibri"];
	}

	const models: Model<"openai-completions">[] = modelIds.map((modelId) => ({
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: id,
		baseUrl: `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	}));

	const mutex = createMutex();
	const base = serializeWithBusyRetry(openAICompletionsApi());
	const provider = createProvider({
		id,
		name: `Colibri (${baseUrl})`,
		baseUrl: `${baseUrl}/v1`,
		auth: { apiKey: colibriAuth() },
		models,
		api: {
			stream: (model, context, options) => mutex(() => Promise.resolve(base.stream(model, context, options))),
			streamSimple: (model, context, options) =>
				mutex(() => Promise.resolve(base.streamSimple(model, context, options))),
		},
	});
	pi.registerProvider(provider);
}
