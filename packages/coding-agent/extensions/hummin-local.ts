/** Fleet-driven, per-engine/host providers. Local requests share an abortable
 * process lock through the end of the stream. Discovery never invents IDs. */
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import {
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
	withLocalInferenceLock,
} from "@earendil-works/pi-coding-agent";

type FleetServerSettings = ReturnType<SettingsManager["getFleetServers"]>[number];

const MAX_BUSY_RETRIES = 5;
const BUSY_BASE_DELAY_MS = 2000;
const BUSY_MAX_DELAY_MS = 30000;

// Failover-worthy transport failures: server down, unreachable, or the TCP
// stream died before any content. Deliberately narrow - HTTP-level model
// errors (context overflow, bad request) would fail identically on every
// fleet host, so they surface to the user instead of cascading.
const CONNECTIVITY_ERROR =
	/\bfetch failed\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|connection refused|connection lost/i;

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

export interface SerializedStreamOptions {
	/** Called when the stream hands off from one candidate to the next. */
	onFailover?: (from: Model<Api>, to: Model<Api>, reason: "unreachable" | "busy") => void;
	/** Retry knobs for tests only; production callers use the defaults. */
	busyBaseDelayMs?: number;
	maxBusyRetries?: number;
}

type CandidateOutcome =
	| { status: "completed" }
	| { status: "aborted" }
	| { status: "failover"; reason: "unreachable" | "busy"; errorMessage: string }
	| { status: "failed"; connectivity: boolean; errorMessage: string };

/** Run one candidate endpoint to completion under its own inference lock.
 * Never emits terminal events itself except on completion paths - the caller
 * decides failover vs terminal emission. */
async function runCandidate(
	model: Model<Api>,
	signal: AbortSignal | undefined,
	streamFactory: (model: Model<Api>, signal: AbortSignal) => AssistantMessageEventStream,
	events: AssistantMessageEventStream,
	options: SerializedStreamOptions,
): Promise<CandidateOutcome> {
	const maxRetries = options.maxBusyRetries ?? MAX_BUSY_RETRIES;
	const baseDelay = options.busyBaseDelayMs ?? BUSY_BASE_DELAY_MS;
	try {
		return await withLocalInferenceLock(model.baseUrl, signal, async (lockedSignal) => {
			for (let attempt = 0; ; attempt++) {
				lockedSignal.throwIfAborted();
				if (attempt)
					await delay(Math.min(baseDelay * attempt, BUSY_MAX_DELAY_MS), undefined, { signal: lockedSignal });
				let retry = false;
				let emittedContent = false;
				for await (const event of streamFactory(model, lockedSignal)) {
					if (event.type === "error" && !emittedContent) {
						const message = event.error?.errorMessage ?? "";
						if (/\b429\b|\bbusy\b|\boverloaded\b/i.test(message)) {
							if (attempt < maxRetries) {
								retry = true;
								break;
							}
							// Busy beyond the retry budget: another fleet host may be free.
							return { status: "failover", reason: "busy", errorMessage: message };
						}
						if (CONNECTIVITY_ERROR.test(message)) {
							return { status: "failover", reason: "unreachable", errorMessage: message };
						}
					}
					if (event.type !== "start" && event.type !== "error") emittedContent = true;
					events.push(event);
					if (event.type === "done" || event.type === "error") return { status: "completed" };
				}
				if (!retry) throw new Error("Local provider stream ended without a terminal event");
			}
		});
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			return { status: "aborted" };
		}
		const message = String(error);
		return { status: "failed", connectivity: CONNECTIVITY_ERROR.test(message), errorMessage: message };
	}
}

function failureMessage(model: Model<Api>, aborted: boolean, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
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
}

/** Stream from the first fleet endpoint that can serve the request. The
 * candidate list starts with the selected model and continues with the other
 * fleet instances of the same model id, in fleet priority order. Failover
 * happens only before any content is emitted, only on connectivity-class
 * failures or busy exhaustion, and each hop takes its own server's lock. */
export function serializedLocalStream(
	candidates: Model<Api> | readonly Model<Api>[],
	signal: AbortSignal | undefined,
	streamFactory: (model: Model<Api>, signal: AbortSignal) => AssistantMessageEventStream,
	options: SerializedStreamOptions = {},
): AssistantMessageEventStream {
	const list = Array.isArray(candidates) ? [...candidates] : [candidates];
	const events = createAssistantMessageEventStream();
	void (async () => {
		for (let index = 0; index < list.length; index++) {
			const model = list[index]!;
			const outcome = await runCandidate(model, signal, streamFactory, events, options);
			switch (outcome.status) {
				case "completed":
					return;
				case "aborted":
					events.push({
						type: "error",
						reason: "aborted",
						error: failureMessage(model, true, "aborted"),
					});
					return;
				case "failover":
				case "failed": {
					const canFailOver =
						outcome.status === "failover" || (outcome.status === "failed" && outcome.connectivity);
					if (canFailOver && index + 1 < list.length) {
						const next = list[index + 1]!;
						options.onFailover?.(
							model,
							next,
							outcome.status === "failover" ? outcome.reason : "unreachable",
						);
						continue;
					}
					events.push({
						type: "error",
						reason: "error",
						error: failureMessage(model, false, outcome.errorMessage),
					});
					return;
				}
			}
		}
	})();
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

// Chat templates that take enable_thinking via chat_template_kwargs
// (llama.cpp applies it per request): qwen3.8 and nemotron 3.5 both honor the
// same kwarg (probed live 2026-09-19 - nemotron returns direct content with
// zero reasoning tokens). Other model families register without thinking
// controls rather than sending them kwargs of unknown meaning.
function takesEnableThinking(modelId: string): boolean {
	return /^(qwen|nemotron|north)/i.test(modelId);
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
// Discovery results are cached in module scope briefly: /clear re-runs every
// extension factory, and the fleet does not change in between. Without the
// cache, each /clear re-fetches /v1/models and /props from every fleet
// server, and each unreachable server eats its full fetch timeout (up to 5s).
// The cache is per module instance, so /reload (which re-imports the module)
// always forces fresh discovery.
export const DISCOVERY_TTL_MS = 30_000;

// =============================================================================
// Fleet health persistence: last-known-good discovery per server, kept in
// <agentDir>/fleet-health.json ({servers: {key: {lastSeen, contextWindow,
// models, endpoint}}}, key = engine-host-port). A fresh entry (within
// FLEET_HEALTH_MAX_AGE_MS) fills the offline catalog of a downed server with
// the models it actually served recently and their measured context window,
// and stands in for /props when a running server does not serve that endpoint.
// Offline entries never join failover chains, exactly as before. All file IO
// is fail-open: a missing or corrupt file is an empty state, and bookkeeping
// must never break discovery. Parsing and merging are pure and unit-tested.
// =============================================================================

/** Servers unseen for longer than this stop contributing remembered state. */
export const FLEET_HEALTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface FleetHealthEntry {
	/** ISO timestamp of the last successful discovery against the server. */
	lastSeen: string;
	contextWindow: number;
	models: string[];
	endpoint: string;
}

export interface FleetHealthState {
	servers: Record<string, FleetHealthEntry>;
}

/** Grouping key shared with the provider grouping below (engine + host + port). */
export function fleetServerKey(engine: string, host: string, port: number): string {
	return `${engine}-${host}-${port}`;
}

export function fleetHealthFile(): string {
	return process.env.HUMMIN_FLEET_HEALTH_FILE?.trim() || join(getAgentDir(), "fleet-health.json");
}

function isValidFleetEntry(value: unknown): value is FleetHealthEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.lastSeen === "string" &&
		Number.isFinite(Date.parse(entry.lastSeen)) &&
		typeof entry.contextWindow === "number" &&
		entry.contextWindow > 0 &&
		Array.isArray(entry.models) &&
		entry.models.every((id) => typeof id === "string" && id.length > 0) &&
		typeof entry.endpoint === "string"
	);
}

/** Tolerant parser: a corrupt or non-conforming file parses to an empty state. */
export function parseFleetHealth(text: string): FleetHealthState {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return { servers: {} };
		const raw = (parsed as { servers?: unknown }).servers;
		if (typeof raw !== "object" || raw === null) return { servers: {} };
		const servers: Record<string, FleetHealthEntry> = {};
		for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
			if (isValidFleetEntry(entry)) servers[key] = entry;
		}
		return { servers };
	} catch {
		return { servers: {} };
	}
}

/** Pure merge: updates win per key, every other server's entry is preserved. */
export function mergeFleetHealth(
	previous: FleetHealthState | undefined,
	updates: Readonly<Record<string, FleetHealthEntry>>,
): FleetHealthState {
	return { servers: { ...(previous?.servers ?? {}), ...updates } };
}

/** The persisted entry for a key, but only when well-formed and fresh enough. */
export function freshFleetEntry(
	state: FleetHealthState | undefined,
	key: string,
	nowMs: number,
	maxAgeMs: number = FLEET_HEALTH_MAX_AGE_MS,
): FleetHealthEntry | undefined {
	const entry = state?.servers[key];
	if (!entry || !isValidFleetEntry(entry)) return undefined;
	if (!Number.isFinite(nowMs - Date.parse(entry.lastSeen))) return undefined;
	return nowMs - Date.parse(entry.lastSeen) <= maxAgeMs ? entry : undefined;
}

function readFleetHealth(path: string): FleetHealthState {
	try {
		return parseFleetHealth(readFileSync(path, "utf8"));
	} catch {
		return { servers: {} };
	}
}

/** Atomic tmp+replace write (rename is atomic on POSIX); failures are dropped. */
function writeFleetHealth(path: string, state: FleetHealthState): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	} catch {
		// fail-open: health bookkeeping must never break discovery
	}
}

interface DiscoveredInstance {
	modelId: string;
	baseUrl: string;
	host: string;
	port: number;
	engine: "colibri" | "llamacpp";
	contextWindow: number;
	offline: boolean;
}

let discoveryCache: { key: string; instances: DiscoveredInstance[]; expiresAt: number } | undefined;

async function discoverInstances(configs: InstanceConfig[]): Promise<DiscoveredInstance[]> {
	const instanceMeta = new Map(
		configs.map((config) => [config.baseUrl, config] as const),
	);
	const health = readFleetHealth(fleetHealthFile());
	const nowMs = Date.now();
	const instances = configs.map((config) => config.baseUrl);
	// Per-instance model discovery: no cross-host dedupe - each host is a
	// distinct, explicitly selectable endpoint (engine + host are visible).
	const serving: DiscoveredInstance[] = [];
	const discovered = await Promise.allSettled(
		instances.map(async (baseUrl) => {
			const meta = instanceMeta.get(baseUrl)!;
			const remembered = freshFleetEntry(
				health,
				fleetServerKey(meta.engine, meta.hostLabel, meta.port),
				nowMs,
			);
			const [ids, contextWindow] = await Promise.all([
				fetchModels(baseUrl, process.env.COLI_API_KEY),
				fetchContextWindow(baseUrl, process.env.COLI_API_KEY),
			]);
			return {
				baseUrl,
				ids,
				// A fresh persisted window beats the env fallback: it was measured
				// from /props on a previous run and env fallbacks are coarse.
				contextWindow:
					contextWindow ??
					remembered?.contextWindow ??
					Number(process.env.HUMMIN_CTX ?? process.env.HUMMIN_COLIBRI_CTX ?? 16384),
			};
		}),
	);

	// Health bookkeeping: servers that answered refresh their last-known-good
	// entry. One merged write per discovery run; downed servers keep theirs.
	const updates: Record<string, FleetHealthEntry> = {};
	for (const result of discovered) {
		if (result.status !== "fulfilled") continue;
		const meta = instanceMeta.get(result.value.baseUrl)!;
		updates[fleetServerKey(meta.engine, meta.hostLabel, meta.port)] = {
			lastSeen: new Date(nowMs).toISOString(),
			contextWindow: result.value.contextWindow,
			models: result.value.ids,
			endpoint: result.value.baseUrl,
		};
	}
	if (Object.keys(updates).length > 0) {
		writeFleetHealth(fleetHealthFile(), mergeFleetHealth(health, updates));
	}
	const reachableBaseUrls = new Set(Object.values(updates).map((entry) => entry.endpoint));

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
	// fresh session reads /props). A fresh persisted entry widens that catalog
	// to the models the server actually served recently, so a downed host keeps
	// real picker entries instead of falling straight to HUMMIN_CTX/16384.
	// Generation against an off server fails with connection refused - start it
	// from the menubar.
	for (const config of configs) {
		const remembered = reachableBaseUrls.has(config.baseUrl)
			? undefined
			: freshFleetEntry(health, fleetServerKey(config.engine, config.hostLabel, config.port), nowMs);
		const listed = new Set(
			serving.filter((entry) => entry.baseUrl === config.baseUrl).map((entry) => entry.modelId),
		);
		for (const entry of config.models ?? []) {
			listed.add(entry.id);
			serving.push({
				modelId: entry.id,
				baseUrl: config.baseUrl,
				host: config.hostLabel,
				port: config.port,
				engine: config.engine,
				contextWindow: remembered?.contextWindow ?? entry.contextWindow,
				offline: true,
			});
		}
		if (remembered) {
			for (const modelId of remembered.models) {
				if (listed.has(modelId)) continue;
				listed.add(modelId);
				serving.push({
					modelId,
					baseUrl: config.baseUrl,
					host: config.hostLabel,
					port: config.port,
					engine: config.engine,
					contextWindow: remembered.contextWindow,
					offline: true,
				});
			}
		}
	}
	return serving;
}

async function cachedDiscovery(configs: InstanceConfig[]): Promise<DiscoveredInstance[]> {
	// Key covers everything discovery reads: the fleet config (order =
	// priority, including per-server catalogs), the auth key, and the
	// context-window env fallback. Any change invalidates the cache.
	const key = JSON.stringify([
		configs,
		process.env.COLI_API_KEY ?? "",
		process.env.HUMMIN_CTX ?? process.env.HUMMIN_COLIBRI_CTX ?? "",
	]);
	const now = Date.now();
	const cached = discoveryCache;
	if (cached && cached.key === key && cached.expiresAt > now) {
		return cached.instances;
	}
	const instances = await discoverInstances(configs);
	discoveryCache = { key, instances, expiresAt: now + DISCOVERY_TTL_MS };
	return instances;
}

export default async function humminLocalExtension(pi: ExtensionAPI): Promise<void> {
	const configs = instanceConfigs();
	if (configs.length === 0) {
		return;
	}
	const serving = await cachedDiscovery(configs);
	if (serving.length === 0) {
		return;
	}

	const base = openAICompletionsApi();

	const instanceModels = new Map<DiscoveredInstance, Model<"openai-completions">>();

	// Fleet failover chains: model id -> every online fleet endpoint serving it,
	// in fleet priority order (discovery preserves fleet.servers order), with
	// the selected endpoint first. Endpoints marked offline at discovery are
	// skipped; they would only burn the connectivity timeout before failing
	// again. Chains are keyed by model id + endpoint so each provider closure
	// can look up its own fallbacks without cross-provider knowledge.
	const chainKey = (model: { id: string; baseUrl: string }): string => `${model.id}|${model.baseUrl}`;
	const failoverChains = new Map<string, Model<"openai-completions">[]>();
	for (const entry of serving) {
		const model = instanceModels.get(entry);
		if (!model) continue;
		const fallbacks = serving
			.filter((other) => other.modelId === entry.modelId && !other.offline && other.baseUrl !== entry.baseUrl)
			.map((other) => instanceModels.get(other))
			.filter((other): other is Model<"openai-completions"> => other !== undefined);
		failoverChains.set(chainKey(model), [model, ...fallbacks]);
	}

	// ctx.ui is only reachable from event/command handlers, never from provider
	// streams. Capture notify at session start so failovers can surface there.
	let notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		notify = (message, type) => ctx.ui.notify(message, type);
	});

	const failoverNotify = (): SerializedStreamOptions["onFailover"] => (from, to, reason) => {
		const label = (candidate: Model<Api>): string =>
			`${displayName(candidate.id)} [${(candidate as Model<Api> & HumminModelMetadata).humminHost ?? candidate.provider}]`;
		notify?.(`Fleet failover: ${label(from)} ${reason}, trying ${label(to)}`, "warning");
	};

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
		const models: Model<"openai-completions">[] = group.entries.map((entry) => {
			const model = {
				id: entry.modelId,
				name: `${displayName(entry.modelId)} [${hostLabel}]${entry.offline ? " (offline - start from menubar)" : ""}`,
				api: "openai-completions",
				provider: providerId,
				baseUrl: `${entry.baseUrl}/v1`,
				reasoning: takesEnableThinking(entry.modelId),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: entry.contextWindow,
				// Local reasoning models can spend more than 4k tokens before emitting
				// answer text. The simple-stream path clamps this against the prompt and
				// keeps a context safety margin before sending max_tokens to the server.
				maxTokens: entry.contextWindow,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					maxTokensField: "max_tokens",
					...(takesEnableThinking(entry.modelId) ? { thinkingFormat: "qwen-chat-template" as const } : {}),
				},
				// The picker uses these optional fields for styling. They survive the
				// provider/model runtime because models are passed by reference.
				humminHost: hostLabel,
				humminOffline: entry.offline,
			} as Model<"openai-completions"> & HumminModelMetadata;
			instanceModels.set(entry, model);
			return model;
		});
		const provider = createProvider({
			id: providerId,
			name: providerName,
			baseUrl: `${group.entries[0]!.baseUrl}/v1`,
			auth: { apiKey: localAuth() },
			models,
			api: {
				stream: (model, context, options) =>
					serializedLocalStream(
						failoverChains.get(chainKey(model)) ?? [model],
						options?.signal,
						(candidate, signal) => base.stream(candidate, context, { ...options, signal }),
						{ onFailover: failoverNotify() },
					),
				streamSimple: (model, context, options) =>
					serializedLocalStream(
						failoverChains.get(chainKey(model)) ?? [model],
						options?.signal,
						(candidate, signal) => base.streamSimple(candidate, context, { ...options, signal }),
						{ onFailover: failoverNotify() },
					),
			},
		});
		pi.registerProvider(provider);
	}
}
