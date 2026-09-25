import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type Model, type Transport } from "@earendil-works/pi-ai";
import type { TuiMode as RendererTuiMode, ScrollViewScrollbar, TerminalCapabilities } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	modelOverrides?: Record<string, CompactionModelOverride>; // exact "provider/modelId" keys
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	maxAgentDelayMs?: number; // default: 60000
	provider?: ProviderRetrySettings;
}

export interface ProvidersSettings {
	showAll?: boolean; // default: false - /login surfaces curated providers (zai, hummin) plus already-configured ones only
}

export type TuiMode = RendererTuiMode;
export type FullscreenExitOutput = "transcript" | "resume-hint";

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	hyperlinks?: boolean | "auto";
	images?: "kitty" | "iterm2" | "auto" | false;
	trueColor?: boolean | "auto";
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

/** Cache-warming profile. "idle" also warms between agent runs. */
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/** hummin: one local inference server in the fleet */
export interface FleetServerSettings {
	/** stable id (e.g. "mac-qwen") */
	id: string;
	/** display label (e.g. "Qwen 3.8 27B"); defaults to the id */
	label?: string;
	/** display host name (e.g. "Mac"); defaults to hostIp */
	host?: string;
	/** routable IP/hostname used to build the OpenAI-compatible base URL */
	hostIp: string;
	/** port of the OpenAI-compatible endpoint */
	port: number;
	/** service manager used for probe/start/stop/restart */
	kind: "launchd" | "docker";
	/** inference engine used by this endpoint; defaults to llamacpp */
	engine?: "colibri" | "llamacpp"; // colibri = the external container engine (github.com/JustVugg/colibri), like llamacpp
	/** launchd service label, or docker compose service / container name */
	target: string;
	/** staged models this server serves (picker catalog fill-in while the server is off). `capability` tags the model on its provider's rung for the laya right-size gate (optional; untagged = the gate fails open) */
	models?: Array<{
		id: string;
		contextWindow: number;
		capability?: {
			tier: "base" | "pro" | "max";
			speed?: "fast" | "normal" | "slow";
			thinking?: "off" | "limited" | "extended";
		};
	}>;
}

/** hummin: launchd control endpoints for kind "launchd" fleet servers */
export interface FleetLaunchdSettings {
	/** launchd domain (default: gui/<uid>) */
	domain?: string;
	/** directory holding the LaunchAgents plists (default: ~/Library/LaunchAgents) */
	plistDir?: string;
}

/** hummin: docker control endpoints for kind "docker" fleet servers */
export interface FleetDockerSettings {
	/** ssh target of the docker host (e.g. "user@host"; "localhost" for local docker) */
	sshHost?: string;
	/** docker compose project directory on the docker host */
	composeDir?: string;
}

/**
 * hummin: local inference fleet. Server list order is priority: when several
 * servers serve the same model, the first match wins (later ones are fallback).
 */
export interface FleetSettings {
	servers?: FleetServerSettings[];
	launchd?: FleetLaunchdSettings;
	docker?: FleetDockerSettings;
	/** Skip the "Start <server>?" confirm when an offline fleet model is selected (env HUMMIN_FLEET_AUTOSTART overrides). */
	autoStart?: boolean;
}

/** hummin: custom statusline layout — ordered segment tokens per footer side. */
export interface StatuslineSettings {
	left?: string[];
	right?: string[];
}

/** Known statusline segment tokens. Unknown strings are kept and rendered dim as-is. */
export const STATUSLINE_TOKENS = [
	"dir",
	"repo",
	"branch",
	"model",
	"provider",
	"ctx",
	"tokens",
	"cost",
	"queue",
	"background",
	"sandbox",
	"mcp",
	"git",
	"diff",
] as const;

export type StatuslineToken = (typeof STATUSLINE_TOKENS)[number];

/** Tolerant parse of one statusline side: keep non-empty strings, drop everything else. */
export function parseStatuslineSegments(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export interface Settings {
	layaRightSize?: {
		enabled?: boolean;
		swingThreshold?: number;
		profiles?: Array<Record<string, unknown>>;
	};
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>; // per-model default thinking level overrides keyed by "provider/modelId"
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	/** What Enter does while the agent is streaming: "steer" interrupts now, "followUp" queues until the turn ends. */
	streamingSubmitMode?: "steer" | "followUp";
	/** Show local timestamps under user and extension messages. */
	messageTimestamps?: boolean;
	/** Compact prompt mode: condense tool descriptions and system-prompt guidance to cut fixed prompt overhead (useful for slow-prefill local models). */
	compactPrompt?: boolean;
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	providers?: ProvidersSettings;
	hideThinkingBlock?: boolean;
	showCacheMissNotices?: boolean; // default: false - show cache cost and provider recovery notices
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	/** hummin: project-memory distillation + vault (env HUMMIN_MEMORY overrides) */
	memoryEnabled?: boolean;
	/** hummin: lesson (default) or vault */
	memoryMode?: "lesson" | "vault";
	/** hummin: where the knowledge-graph vault lives (env HUMMIN_MEMORY_VAULT_DIR overrides) */
	memoryVaultDir?: string;
	/** hummin: provider for vault fold + distillation calls (env HUMMIN_MEMORY_PROVIDER overrides) */
	memoryProvider?: string;
	/** hummin: model id for vault fold + distillation calls (env HUMMIN_MEMORY_MODEL_ID overrides) */
	memoryModelId?: string;
	/** hummin laya: bash gate block threshold, 0..1 (env HUMMIN_LAYA_GATE_THRESHOLD overrides) */
	layaGateThreshold?: number;
	/** hummin laya: per-turn destructive steer threshold, 0..1 (env HUMMIN_LAYA_STEER_THRESHOLD overrides) */
	layaSteerThreshold?: number;
	/** hummin: local inference server base URLs for the hummin provider (env HUMMIN_INSTANCES overrides) */
	localInstances?: string[];
	/** @deprecated pre-rename key, read as a fallback for localInstances */
	colibriInstances?: string[];
	/** hummin: local inference fleet (ordered list = priority). Drives /fleet, /status, and the hummin provider's instance list + staged-model catalog. */
	fleet?: FleetSettings;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	defaultTools?: string[]; // Initial built-in tool selection
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	/** hummin: input editor key mode (env HUMMIN_VIM=1 overrides) */
	editorMode?: "default" | "vim";
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	cacheWarming?: CacheWarmingMode; // default: "streaming"; global only because each refresh costs money
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	tuiMode?: TuiMode; // default: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // default: "transcript"; no effect in regular TUI mode
	fullscreenScrollbar?: ScrollViewScrollbar; // default: "auto"; no effect in regular TUI mode
	fullscreenCopyOnSelect?: boolean; // default: true; no effect in regular TUI mode
	/** hummin: custom statusline segment layout (see STATUSLINE_TOKENS); empty = default footer */
	statusline?: StatuslineSettings;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

/** hummin laya thresholds: env string wins, then the stored setting, then the
 * built-in default. Anything outside 0..1 (or unparseable) is ignored rather
 * than trusted, so a typo can neither weld the gate shut nor open it. */
function resolveLayaThreshold(envRaw: string | undefined, stored: number | undefined, fallback: number): number {
	const clamp = (value: unknown): number | undefined => {
		const n = typeof value === "number" ? value : Number(value);
		return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
	};
	if (envRaw !== undefined && envRaw.trim().length > 0) {
		const fromEnv = clamp(envRaw);
		if (fromEnv !== undefined) return fromEnv;
	}
	return clamp(stored) ?? fallback;
}

/**
 * hummin laya: model right-size gate config. Env `HUMMIN_LAYA_RIGHTSIZE` (0 or
 * off disables the gate) > `layaRightSize.swingThreshold` (project > global) >
 * defaults (enabled: true, swing 0.6). The swing threshold is clamped
 * to 0..1; the enabled flag accepts 0/"0"/off/false to disable.
 */
type LayaRightSizeSettings = NonNullable<Settings["layaRightSize"]>;

function resolveLayaRightSizeConfig(
	env: Readonly<Record<string, string | undefined>>,
	globalRaw: unknown,
	projectRaw: unknown,
): { enabled: boolean; swingThreshold: number; profiles: Array<Record<string, unknown>> } {
	const rawEnabled = env.HUMMIN_LAYA_RIGHTSIZE?.trim().toLowerCase();
	const enabled = rawEnabled === undefined || !["0", "off", "false"].includes(rawEnabled);
	const projectValue =
		typeof projectRaw === "object" && projectRaw !== null
			? (projectRaw as { layaRightSize?: { swingThreshold?: unknown } }).layaRightSize?.swingThreshold
			: undefined;
	const globalValue =
		typeof globalRaw === "object" && globalRaw !== null
			? (globalRaw as { layaRightSize?: { swingThreshold?: unknown } }).layaRightSize?.swingThreshold
			: undefined;
	// project > global, then env > effective value > default (0.6).
	const swing = resolveLayaThreshold(
		env.HUMMIN_LAYA_RIGHTSIZE_SWING,
		(projectValue ?? globalValue) as number | undefined,
		0.6,
	);
	const projectProfiles =
		typeof projectRaw === "object" && projectRaw !== null
			? (projectRaw as { layaRightSize?: { profiles?: unknown } }).layaRightSize?.profiles
			: undefined;
	const globalProfiles =
		typeof globalRaw === "object" && globalRaw !== null
			? (globalRaw as { layaRightSize?: { profiles?: unknown } }).layaRightSize?.profiles
			: undefined;
	const profiles = Array.isArray(projectProfiles ?? globalProfiles)
		? ((projectProfiles ?? globalProfiles) as Array<Record<string, unknown>>)
		: [];
	return { enabled, swingThreshold: swing, profiles };
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(stripBom(content));
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	/** What Enter does while streaming. Default "steer" (interrupt the current turn). */
	getStreamingSubmitMode(): "steer" | "followUp" {
		return this.settings.streamingSubmitMode ?? "steer";
	}

	setStreamingSubmitMode(mode: "steer" | "followUp"): void {
		this.globalSettings.streamingSubmitMode = mode;
		this.markModified("streamingSubmitMode");
		this.save();
	}

	/** Whether user and extension messages show local timestamps. Default true. */
	getMessageTimestamps(): boolean {
		return this.settings.messageTimestamps ?? true;
	}

	/** Whether compact prompt mode condenses tool descriptions and system-prompt guidance. Default false. */
	getCompactPrompt(): boolean {
		return this.settings.compactPrompt ?? false;
	}

	setCompactPrompt(enabled: boolean): void {
		this.globalSettings.compactPrompt = enabled;
		this.markModified("compactPrompt");
		this.save();
	}

	setMessageTimestamps(enabled: boolean): void {
		this.globalSettings.messageTimestamps = enabled;
		this.markModified("messageTimestamps");
		this.save();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	/** hummin: input editor key mode. HUMMIN_VIM=1 forces vim, otherwise
	 * settings, otherwise "default". */
	getEditorMode(): "default" | "vim" {
		if (process.env.HUMMIN_VIM === "1") return "vim";
		return this.settings.editorMode === "vim" ? "vim" : "default";
	}

	setEditorMode(mode: "default" | "vim"): void {
		this.globalSettings.editorMode = mode;
		this.markModified("editorMode");
		this.save();
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return "hummin-dark";
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getProvidersShowAll(): boolean {
		return this.settings.providers?.showAll ?? false;
	}

	setProvidersShowAll(showAll: boolean): void {
		if (!this.globalSettings.providers) {
			this.globalSettings.providers = {};
		}
		this.globalSettings.providers.showAll = showAll;
		this.markModified("providers", "showAll");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		if (!this.globalSettings.modelThinkingLevels) {
			this.globalSettings.modelThinkingLevels = {};
		}
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		const compaction = this.settings.compaction;
		const ordinary = compaction?.[field];
		if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
			throw new Error(
				`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
			);
		}

		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
			);
		}
		const override = entry?.[field];
		if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
			);
		}
		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	/** Resolve each token setting through model override, ordinary setting, then built-in default. */
	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
			maxAgentDelayMs: this.settings.retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.globalSettings.cacheWarming = mode;
		this.markModified("cacheWarming");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	setWebSocketConnectTimeoutMs(timeoutMs: number | undefined): void {
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new Error(`Invalid websocketConnectTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.websocketConnectTimeoutMs = timeoutMs === undefined ? undefined : Math.floor(timeoutMs);
		this.markModified("websocketConnectTimeoutMs");
		this.save();
	}

	getHttpProxy(): string | undefined {
		return this.globalSettings.httpProxy;
	}

	setHttpProxy(proxy: string | undefined): void {
		this.globalSettings.httpProxy = proxy && proxy.trim() !== "" ? proxy : undefined;
		this.markModified("httpProxy");
		this.save();
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setExternalEditor(command: string | undefined): void {
		this.globalSettings.externalEditor = command && command.trim() !== "" ? command : undefined;
		this.markModified("externalEditor");
		this.save();
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		// hummin curation: clean startup by default - the Skills/Extensions/
		// Context listing stays available behind ctrl+o and /settings.
		return this.settings.quietStartup ?? true;
	}

	// hummin memory + local fleet. Env variables take precedence over stored
	// settings so explicit environment always wins; settings fill the gap so
	// `hummin init` can configure everything without shell edits.

	getMemoryEnabled(): boolean {
		const env = process.env.HUMMIN_MEMORY;
		if (env === "1") return true;
		if (env === "0") return false;
		return this.settings.memoryEnabled ?? false;
	}

	getMemoryMode(): "lesson" | "vault" {
		const env = process.env.HUMMIN_MEMORY_MODE;
		if (env === "vault" || env === "lesson") return env;
		return this.settings.memoryMode ?? "lesson";
	}

	getMemoryVaultDir(): string {
		const env = process.env.HUMMIN_MEMORY_VAULT_DIR;
		if (env && env.trim().length > 0) return env;
		return this.settings.memoryVaultDir ?? join(getAgentDir(), "vault");
	}

	/** Provider for vault fold + distillation calls. Env wins, then settings,
	 * then the zai default - the model the user actually runs, so vault work
	 * does not depend on a second configured provider. */
	getMemoryProvider(): string {
		const env = process.env.HUMMIN_MEMORY_PROVIDER;
		if (env && env.trim().length > 0) return env;
		return this.settings.memoryProvider ?? "zai";
	}

	/** Model id for vault fold + distillation calls. Env wins, then settings,
	 * then the glm-5.3-flash default. */
	getMemoryModelId(): string {
		const env = process.env.HUMMIN_MEMORY_MODEL_ID;
		if (env && env.trim().length > 0) return env;
		return this.settings.memoryModelId ?? "glm-5.3-flash";
	}

	/** hummin laya: destructive-intent thresholds. Env wins, then settings,
	 * then the built-in default. A stored value outside 0..1 is ignored so a
	 * typo can neither weld the gate shut nor silently open it. */
	getLayaGateThreshold(): number {
		return resolveLayaThreshold(process.env.HUMMIN_LAYA_GATE_THRESHOLD, this.settings.layaGateThreshold, 0.75);
	}

	/** hummin laya: model right-size gate config. Env > project > global > defaults. */
	getLayaRightSizeConfig(): { enabled: boolean; swingThreshold: number; profiles: Array<Record<string, unknown>> } {
		return resolveLayaRightSizeConfig(process.env, this.settings, this.projectSettings);
	}

	/** hummin laya: stored enabled flag (env may still override at gate time). */
	getLayaRightSizeEnabled(): boolean {
		return this.settings.layaRightSize?.enabled ?? true;
	}

	setLayaRightSizeEnabled(enabled: boolean, scope: "global" | "project" = "global"): void {
		this.setLayaRightSize((settings) => {
			settings.enabled = enabled;
		}, scope);
	}

	/** hummin laya: stored swing threshold (env may still override at gate time). */
	getLayaRightSizeSwingThreshold(): number {
		const value = this.settings.layaRightSize?.swingThreshold;
		return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6;
	}

	setLayaRightSizeSwingThreshold(threshold: number, scope: "global" | "project" = "global"): void {
		this.setLayaRightSize((settings) => {
			settings.swingThreshold = threshold;
		}, scope);
	}

	/** hummin laya: stored model profiles (descriptive metadata for the review). */
	getLayaRightSizeProfiles(): Array<Record<string, unknown>> {
		return Array.isArray(this.settings.layaRightSize?.profiles)
			? (this.settings.layaRightSize.profiles as Array<Record<string, unknown>>)
			: [];
	}

	/** hummin laya: replace the model profiles; validates the minimal shape. */
	setLayaRightSizeProfiles(profiles: unknown, scope: "global" | "project" = "global"): void {
		if (!Array.isArray(profiles)) throw new Error("profiles must be a JSON array");
		for (const profile of profiles) {
			const entry = profile as { provider?: unknown; modelId?: unknown } | null;
			if (
				typeof entry !== "object" ||
				entry === null ||
				typeof entry.provider !== "string" ||
				!entry.provider.trim() ||
				typeof entry.modelId !== "string" ||
				!entry.modelId.trim()
			) {
				throw new Error("each profile needs non-empty provider and modelId strings");
			}
		}
		this.setLayaRightSize((settings) => {
			settings.profiles = profiles as Array<Record<string, unknown>>;
		}, scope);
	}

	private setLayaRightSize(mutate: (settings: LayaRightSizeSettings) => void, scope: "global" | "project"): void {
		if (scope === "project") {
			this.updateProjectSettings("layaRightSize", (settings) => {
				settings.layaRightSize ??= {};
				mutate(settings.layaRightSize);
			});
			return;
		}
		this.globalSettings.layaRightSize ??= {};
		mutate(this.globalSettings.layaRightSize);
		this.markModified("layaRightSize");
		this.save();
	}

	getLayaSteerThreshold(): number {
		return resolveLayaThreshold(process.env.HUMMIN_LAYA_STEER_THRESHOLD, this.settings.layaSteerThreshold, 0.7);
	}

	/** hummin: local inference server base URLs for the hummin provider.
	 * HUMMIN_INSTANCES overrides (HUMMIN_COLIBRI_INSTANCES kept as a
	 * pre-rename fallback); settings key `localInstances` (`colibriInstances`
	 * kept as a pre-rename fallback). */
	getLocalInstances(): string[] {
		const env = process.env.HUMMIN_INSTANCES ?? process.env.HUMMIN_COLIBRI_INSTANCES;
		if (env && env.trim().length > 0) {
			return env
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
		}
		const stored = this.settings.localInstances ?? this.settings.colibriInstances;
		if (Array.isArray(stored) && stored.length > 0) {
			return stored.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
		}
		return ["http://127.0.0.1:9998", "http://127.0.0.1:9997"];
	}

	/** hummin fleet: ordered server list (list order = priority). Empty when unconfigured. */
	getFleetServers(): FleetServerSettings[] {
		const servers = this.settings.fleet?.servers;
		if (!Array.isArray(servers)) return [];
		return servers.filter(
			(s): s is FleetServerSettings =>
				Boolean(s) &&
				typeof s.id === "string" &&
				typeof s.hostIp === "string" &&
				typeof s.port === "number" &&
				typeof s.target === "string" &&
				(s.kind === "launchd" || s.kind === "docker"),
		);
	}

	/** hummin fleet: autoStart skips the server-start confirm (env > project > global). */
	getFleetAutoStart(): boolean {
		if (process.env.HUMMIN_FLEET_AUTOSTART === "1") return true;
		if (process.env.HUMMIN_FLEET_AUTOSTART === "0") return false;
		if (typeof this.projectSettings.fleet?.autoStart === "boolean") return this.projectSettings.fleet.autoStart;
		return this.globalSettings.fleet?.autoStart ?? false;
	}

	setFleetAutoStart(autoStart: boolean): void {
		if (!this.globalSettings.fleet) {
			this.globalSettings.fleet = {};
		}
		this.globalSettings.fleet.autoStart = autoStart;
		this.markModified("fleet");
		this.save();
	}

	/** hummin: parsed statusline layout. Default empty both sides (default footer rendering). */
	getStatusline(): StatuslineSettings {
		const raw = this.settings.statusline;
		if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return { left: [], right: [] };
		}
		const parsed = raw as StatuslineSettings;
		return {
			left: parseStatuslineSegments(parsed.left),
			right: parseStatuslineSegments(parsed.right),
		};
	}

	/** hummin fleet: launchd control endpoints (env HUMMIN_FLEET_LAUNCHD_DOMAIN / HUMMIN_FLEET_PLIST_DIR override). */
	getFleetLaunchd(): { domain: string; plistDir: string } {
		const stored = this.settings.fleet?.launchd;
		const uid = typeof process.getuid === "function" ? process.getuid() : 501;
		return {
			domain: process.env.HUMMIN_FLEET_LAUNCHD_DOMAIN?.trim() || stored?.domain?.trim() || `gui/${uid}`,
			plistDir:
				process.env.HUMMIN_FLEET_PLIST_DIR?.trim() ||
				stored?.plistDir?.trim() ||
				join(homedir(), "Library", "LaunchAgents"),
		};
	}

	/** hummin fleet: docker control endpoints (env HUMMIN_FLEET_SSH_HOST / HUMMIN_FLEET_COMPOSE_DIR override). Values stay empty until configured. */
	getFleetDocker(): { sshHost: string; composeDir: string } {
		const stored = this.settings.fleet?.docker;
		return {
			sshHost: process.env.HUMMIN_FLEET_SSH_HOST?.trim() || stored?.sshHost?.trim() || "",
			composeDir: process.env.HUMMIN_FLEET_COMPOSE_DIR?.trim() || stored?.composeDir?.trim() || "",
		};
	}

	setMemoryEnabled(enabled: boolean, scope: "global" | "project" = "global"): void {
		if (scope === "project") {
			this.updateProjectSettings("memoryEnabled", (settings) => {
				settings.memoryEnabled = enabled;
			});
			return;
		}
		this.globalSettings.memoryEnabled = enabled;
		this.markModified("memoryEnabled");
		this.save();
	}

	setMemoryMode(mode: "lesson" | "vault", scope: "global" | "project" = "global"): void {
		if (scope === "project") {
			this.updateProjectSettings("memoryMode", (settings) => {
				settings.memoryMode = mode;
			});
			return;
		}
		this.globalSettings.memoryMode = mode;
		this.markModified("memoryMode");
		this.save();
	}

	setMemoryVaultDir(dir: string, scope: "global" | "project" = "global"): void {
		if (scope === "project") {
			this.updateProjectSettings("memoryVaultDir", (settings) => {
				settings.memoryVaultDir = dir;
			});
			return;
		}
		this.globalSettings.memoryVaultDir = dir;
		this.markModified("memoryVaultDir");
		this.save();
	}

	setMemoryProvider(provider: string | undefined, scope: "global" | "project" = "global"): void {
		if (scope === "project") {
			this.updateProjectSettings("memoryProvider", (settings) => {
				settings.memoryProvider = provider;
			});
			return;
		}
		this.globalSettings.memoryProvider = provider && provider.trim() !== "" ? provider : undefined;
		this.markModified("memoryProvider");
		this.save();
	}

	setMemoryModelId(modelId: string | undefined, scope: "global" | "project" = "global"): void {
		if (scope === "project") {
			this.updateProjectSettings("memoryModelId", (settings) => {
				settings.memoryModelId = modelId;
			});
			return;
		}
		this.globalSettings.memoryModelId = modelId && modelId.trim() !== "" ? modelId : undefined;
		this.markModified("memoryModelId");
		this.save();
	}

	setLocalInstances(instances: string[], scope: "global" | "project" = "global"): void {
		if (scope === "project") {
			this.updateProjectSettings("localInstances", (settings) => {
				settings.localInstances = instances;
			});
			return;
		}
		this.globalSettings.localInstances = instances;
		this.markModified("localInstances");
		this.save();
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? false;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.settings.terminal;
		const images = terminal?.images;
		return {
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.settings.fullscreenCopyOnSelect ?? true;
	}

	setFullscreenCopyOnSelect(enabled: boolean): void {
		this.globalSettings.fullscreenCopyOnSelect = enabled;
		this.markModified("fullscreenCopyOnSelect");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		return tools ? [...tools] : undefined;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
