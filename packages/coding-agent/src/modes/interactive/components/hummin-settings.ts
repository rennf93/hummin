import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Container,
	getKeybindings,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Spacer,
} from "@earendil-works/pi-tui";
import { THINKING_LEVEL_OPTIONS } from "../../../core/defaults.ts";
import {
	parseRightSizeProfiles,
	type RightSizeProfile,
	RightSizeProfilesSubmenu,
	type SettingsCategory,
	SettingsTabBar,
	TextInputSubmenu,
} from "./hummin-settings-widgets.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector.ts";

export { type SettingsCategory, SettingsTabBar } from "./hummin-settings-widgets.ts";

const WS_CONNECT_TIMEOUT_CHOICES = [
	{ label: "5 sec", timeoutMs: 5_000 },
	{ label: "10 sec", timeoutMs: 10_000 },
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

function formatWsConnectTimeoutMs(timeoutMs: number | undefined): string {
	if (timeoutMs === undefined) return "default";
	const choice = WS_CONNECT_TIMEOUT_CHOICES.find((c) => c.timeoutMs === timeoutMs);
	return choice ? choice.label : `${Math.round(timeoutMs / 1000)} sec`;
}

function parseWsConnectTimeoutChoice(value: string): number | undefined {
	if (value === "default") return undefined;
	const choice = WS_CONNECT_TIMEOUT_CHOICES.find((c) => c.label === value);
	return choice ? choice.timeoutMs : undefined;
}

function splitInstances(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function splitArgv(value: string): string[] {
	return value
		.split(/\s+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Config fields behind hummin-only settings. */
export interface HumminSettingsConfig {
	streamingSubmitMode: "steer" | "followUp";
	messageTimestamps: boolean;
	compactPrompt: boolean;
	terminalNotifications: string;
	terminalNotificationsWhen: string;
	providersShowAll: boolean;
	retryEnabled: boolean;
	memoryEnabled: boolean;
	memoryMode: "lesson" | "vault";
	memoryVaultDir: string;
	memoryProvider: string;
	memoryModelId: string;
	localInstances: string[];
	fleetAutoStart: boolean;
	rightSizeEnabled: boolean;
	rightSizeSwingThreshold: number;
	rightSizeProfileCount: number;
	rightSizeProfilesJson: string;
	editorMode: "default" | "vim";
	externalEditor: string;
	websocketConnectTimeoutMs: number | undefined;
	httpProxy: string;
	shellPath: string;
	shellCommandPrefix: string;
	npmCommand: string;
	enableAnalytics: boolean;
}

/** Callbacks behind hummin-only settings. */
export interface HumminSettingsCallbacks {
	onStreamingSubmitModeChange: (mode: "steer" | "followUp") => void;
	onMessageTimestampsChange: (enabled: boolean) => void;
	onCompactPromptChange: (enabled: boolean) => void;
	onTerminalNotificationsChange: (channel: string) => void;
	onTerminalNotificationsWhenChange: (when: string) => void;
	onDefaultThinkingLevelChange: (level: ThinkingLevel) => void;
	onProvidersShowAllChange: (enabled: boolean) => void;
	onRetryEnabledChange: (enabled: boolean) => void;
	onMemoryEnabledChange: (enabled: boolean) => void;
	onMemoryModeChange: (mode: "lesson" | "vault") => void;
	onMemoryVaultDirChange: (dir: string) => void;
	onMemoryProviderChange: (provider: string) => void;
	onMemoryModelIdChange: (modelId: string) => void;
	onLocalInstancesChange: (instances: string[]) => void;
	onFleetAutoStartChange: (enabled: boolean) => void;
	onRightSizeEnabledChange: (enabled: boolean) => void;
	onRightSizeSwingThresholdChange: (threshold: number) => void;
	onRightSizeProfilesChange: (profilesJson: string) => void;
	onEditorModeChange: (mode: "default" | "vim") => void;
	onExternalEditorChange: (command: string) => void;
	onWebSocketConnectTimeoutMsChange: (timeoutMs: number | undefined) => void;
	onHttpProxyChange: (proxy: string) => void;
	onShellPathChange: (path: string) => void;
	onShellCommandPrefixChange: (prefix: string) => void;
	onNpmCommandChange: (command: string[]) => void;
	onEnableAnalyticsChange: (enabled: boolean) => void;
}

/** Dispatcher for the hummin-only setting ids; the selector calls it for ids it does not handle itself. */
export function handleHumminSettingChange(callbacks: HumminSettingsCallbacks, id: string, newValue: string): void {
	switch (id) {
		case "message-timestamps":
			callbacks.onMessageTimestampsChange(newValue === "true");
			break;
		case "compact-prompt":
			callbacks.onCompactPromptChange(newValue === "true");
			break;
		case "streaming-submit-mode":
			callbacks.onStreamingSubmitModeChange(newValue as "steer" | "followUp");
			break;
		case "retry-enabled":
			callbacks.onRetryEnabledChange(newValue === "true");
			break;
		case "default-thinking-level":
			callbacks.onDefaultThinkingLevelChange(newValue as ThinkingLevel);
			break;
		case "providers-show-all":
			callbacks.onProvidersShowAllChange(newValue === "true");
			break;
		case "memory-enabled":
			callbacks.onMemoryEnabledChange(newValue === "true");
			break;
		case "memory-mode":
			callbacks.onMemoryModeChange(newValue as "lesson" | "vault");
			break;
		case "memory-vault-dir":
			callbacks.onMemoryVaultDirChange(newValue);
			break;
		case "memory-provider":
			callbacks.onMemoryProviderChange(newValue);
			break;
		case "memory-model":
			callbacks.onMemoryModelIdChange(newValue);
			break;
		case "local-instances":
			callbacks.onLocalInstancesChange(splitInstances(newValue));
			break;
		case "fleet-auto-start":
			callbacks.onFleetAutoStartChange(newValue === "true");
			break;
		case "right-size-gate":
			callbacks.onRightSizeEnabledChange(newValue === "true");
			break;
		case "right-size-swing-threshold":
			callbacks.onRightSizeSwingThresholdChange(Number(newValue));
			break;
		case "editor-mode":
			callbacks.onEditorModeChange(newValue as "default" | "vim");
			break;
		case "external-editor":
			callbacks.onExternalEditorChange(newValue);
			break;
		case "terminal-notifications":
			callbacks.onTerminalNotificationsChange(newValue);
			break;
		case "terminal-notifications-when":
			callbacks.onTerminalNotificationsWhenChange(newValue);
			break;
		case "websocket-connect-timeout":
			callbacks.onWebSocketConnectTimeoutMsChange(parseWsConnectTimeoutChoice(newValue));
			break;
		case "http-proxy":
			callbacks.onHttpProxyChange(newValue);
			break;
		case "shell-path":
			callbacks.onShellPathChange(newValue);
			break;
		case "shell-command-prefix":
			callbacks.onShellCommandPrefixChange(newValue);
			break;
		case "npm-command":
			callbacks.onNpmCommandChange(splitArgv(newValue));
			break;
		case "enable-analytics":
			callbacks.onEnableAnalyticsChange(newValue === "true");
			break;
	}
}

export const SETTINGS_CATEGORIES = [
	{ id: "general", label: "General" },
	{ id: "agent", label: "Agent" },
	{ id: "models", label: "Models" },
	{ id: "memory", label: "Memory" },
	{ id: "fleet", label: "Fleet" },
	{ id: "editor", label: "Editor" },
	{ id: "terminal", label: "Terminal" },
	{ id: "network", label: "Network" },
	{ id: "shell", label: "Shell" },
	{ id: "privacy", label: "Privacy" },
] as const;

const FALLBACK_CATEGORY: SettingsCategory = { id: "other", label: "Other" };

/**
 * Item ids per category, in display order. Ids without an item (e.g. image
 * settings on terminals without image support) are skipped.
 */
const CATEGORY_ITEM_IDS: Record<string, readonly string[]> = {
	general: [
		"quiet-startup",
		"collapse-changelog",
		"message-timestamps",
		"skill-commands",
		"default-project-trust",
		"warnings",
	],
	agent: [
		"autocompact",
		"compact-prompt",
		"streaming-submit-mode",
		"steering-mode",
		"follow-up-mode",
		"retry-enabled",
		"cache-warming-mode",
		"hide-thinking",
		"mermaid-rendering",
		"cache-miss-notices",
	],
	models: ["default-thinking-level", "model-thinking", "providers-show-all"],
	memory: ["memory-enabled", "memory-mode", "memory-vault-dir", "memory-provider", "memory-model"],
	fleet: [
		"local-instances",
		"fleet-auto-start",
		"right-size-gate",
		"right-size-swing-threshold",
		"right-size-profiles",
	],
	editor: [
		"editor-mode",
		"double-escape-action",
		"tree-filter-mode",
		"editor-padding",
		"autocomplete-max-visible",
		"show-hardware-cursor",
		"external-editor",
	],
	terminal: [
		"theme",
		"tui-mode",
		"show-images",
		"image-width-cells",
		"fullscreen-exit-output",
		"fullscreen-scrollbar",
		"fullscreen-copy-on-select",
		"fullscreen-wheel-scroll-lines",
		"clear-on-shrink",
		"terminal-progress",
		"terminal-notifications",
		"terminal-notifications-when",
		"output-padding",
		"auto-resize-images",
		"block-images",
	],
	network: ["transport", "share-destination", "http-idle-timeout", "websocket-connect-timeout", "http-proxy"],
	shell: ["shell-path", "shell-command-prefix", "npm-command"],
	privacy: ["install-telemetry", "enable-analytics"],
};

/** Hummin wording for upstream items. */
const DESCRIPTION_OVERRIDES: Record<string, string> = {
	"steering-mode":
		"Steering delivery: 'one-at-a-time' delivers one and waits for a response; 'all' delivers all at once.",
	"cache-warming-mode":
		"off; streaming while the agent runs; idle also between runs while continuation stays profitable; always warms regardless of economics (local fleet slots)",
	"tui-mode": "Interface layout; fullscreen mode is experimental",
	"show-hardware-cursor": "Use the terminal cursor instead of the drawn cursor",
};

function createHumminItems(config: SettingsConfig, callbacks: SettingsCallbacks): SettingItem[] {
	// Free-text field: saving reports done(value), which flows through the shared
	// onChange dispatcher to the matching callback.
	const textSubmenu =
		(label: string) =>
		(currentValue: string, done: (selectedValue?: string) => void): Component =>
			new TextInputSubmenu(
				label,
				"",
				currentValue,
				"",
				(value) => done(value),
				() => done(),
			);

	return [
		{
			id: "message-timestamps",
			label: "Message timestamps",
			description: "Show local timestamps below user and extension messages.",
			currentValue: config.messageTimestamps ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "compact-prompt",
			label: "Compact prompt",
			description:
				"Condense tool descriptions and guidance to cut fixed prompt overhead (best for slow local models). Takes effect next turn.",
			currentValue: config.compactPrompt ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "streaming-submit-mode",
			label: "Enter while streaming",
			description: "Steer the current response, or queue a follow-up until the agent finishes.",
			currentValue: config.streamingSubmitMode,
			values: ["steer", "followUp"],
		},
		{
			id: "retry-enabled",
			label: "Retry on failure",
			description: "Automatically retry failed agent turns with exponential backoff",
			currentValue: config.retryEnabled ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "default-thinking-level",
			label: "Default thinking level",
			description:
				"Global default reasoning effort for models that support thinking; also applies to the current session",
			currentValue: config.thinkingLevel,
			values: [...(config.availableThinkingLevels ?? THINKING_LEVEL_OPTIONS)],
		},
		{
			id: "providers-show-all",
			label: "Show all providers",
			description: "/login lists every known provider instead of the curated set plus already-configured ones",
			currentValue: config.providersShowAll ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "memory-enabled",
			label: "Memory",
			description: "Distill sessions into reusable lessons (and a knowledge vault in vault mode)",
			currentValue: config.memoryEnabled ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "memory-mode",
			label: "Memory mode",
			description: "lesson: flat lesson notes · vault: linked entity graph with [[wikilinks]]",
			currentValue: config.memoryMode,
			values: ["lesson", "vault"],
		},
		{
			id: "memory-vault-dir",
			label: "Vault directory",
			description: "Where the knowledge vault lives. HUMMIN_MEMORY_VAULT_DIR env var takes precedence.",
			currentValue: config.memoryVaultDir,
			submenu: textSubmenu("Memory vault directory"),
		},
		{
			id: "memory-provider",
			label: "Memory provider",
			description: "Provider for distillation/fold calls. HUMMIN_MEMORY_PROVIDER env var takes precedence.",
			currentValue: config.memoryProvider,
			submenu: textSubmenu("Memory provider"),
		},
		{
			id: "memory-model",
			label: "Memory model",
			description: "Model id for distillation/fold calls. HUMMIN_MEMORY_MODEL_ID env var takes precedence.",
			currentValue: config.memoryModelId,
			submenu: textSubmenu("Memory model"),
		},
		{
			id: "local-instances",
			label: "Local instances",
			description:
				"Base URLs for the hummin provider, comma-separated. HUMMIN_INSTANCES env var takes precedence; applies after /reload. Fleet servers live in the settings.json fleet block (see /fleet).",
			currentValue: config.localInstances.join(", "),
			submenu: textSubmenu("Local instances"),
		},
		{
			id: "fleet-auto-start",
			label: "Fleet auto-start",
			description:
				"Start an offline fleet server automatically when its model is selected. HUMMIN_FLEET_AUTOSTART env var takes precedence.",
			currentValue: config.fleetAutoStart ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "right-size-gate",
			label: "Right-size gate",
			description:
				"The System-1 engine reviews child dispatches (task, cron) against the model catalog and holds confident mismatches for review. HUMMIN_SYS1_RIGHTSIZE=off takes precedence.",
			currentValue: config.rightSizeEnabled ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "right-size-swing-threshold",
			label: "Right-size swing threshold",
			description:
				"Confidence margin between the engine's pick and the requested model that turns a mismatch into a dispatch hold. HUMMIN_SYS1_RIGHTSIZE_SWING takes precedence.",
			currentValue: String(config.rightSizeSwingThreshold),
			values: ["0.25", "0.3", "0.35", "0.4", "0.45", "0.5", "0.6"],
		},
		{
			id: "right-size-profiles",
			label: "Right-size model profiles",
			description:
				"Per-model description/speed/cost metadata the right-size review sees. Enter to open the profile editor.",
			currentValue: `${config.rightSizeProfileCount} configured`,
			submenu: (_current: string, done: (selectedValue?: string) => void) => {
				let profiles: RightSizeProfile[];
				try {
					profiles = parseRightSizeProfiles(config.rightSizeProfilesJson);
				} catch {
					profiles = [];
				}
				return new RightSizeProfilesSubmenu(
					profiles,
					(updated) => callbacks.onRightSizeProfilesChange(JSON.stringify(updated)),
					() => done(),
				);
			},
		},
		{
			id: "editor-mode",
			label: "Editor mode",
			description:
				"default: standard keys · vim: modal editing (applies to new sessions; HUMMIN_VIM=1 takes precedence)",
			currentValue: config.editorMode,
			values: ["default", "vim"],
		},
		{
			id: "external-editor",
			label: "External editor",
			description: "Command for the external editor keybinding. Empty falls back to VISUAL/EDITOR.",
			currentValue: config.externalEditor,
			submenu: textSubmenu("External editor command"),
		},
		{
			id: "terminal-notifications",
			label: "Notifications",
			description: "BEL/OSC 9/desktop notification when a turn ends or the agent asks a question",
			currentValue: config.terminalNotifications,
			values: ["off", "bell", "osc9", "desktop", "all"],
		},
		{
			id: "terminal-notifications-when",
			label: "Notify when",
			description: "Notify always, or only when the terminal is not focused (focus reporting)",
			currentValue: config.terminalNotificationsWhen,
			values: ["unfocused", "always"],
		},
		{
			id: "websocket-connect-timeout",
			label: "WebSocket connect timeout",
			description:
				"Timeout for the WebSocket connect/open handshake on websocket transports. Applies to new requests.",
			currentValue: formatWsConnectTimeoutMs(config.websocketConnectTimeoutMs),
			values: ["default", ...WS_CONNECT_TIMEOUT_CHOICES.map((choice) => choice.label)],
		},
		{
			id: "http-proxy",
			label: "HTTP proxy",
			description:
				"Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients. Applies to new requests.",
			currentValue: config.httpProxy,
			submenu: textSubmenu("HTTP proxy URL"),
		},
		{
			id: "shell-path",
			label: "Shell path",
			description: "Custom shell path for bash commands (e.g. for Cygwin users). Empty uses the default shell.",
			currentValue: config.shellPath,
			submenu: textSubmenu("Shell path"),
		},
		{
			id: "shell-command-prefix",
			label: "Shell command prefix",
			description: "Prefix prepended to every bash command (e.g. 'shopt -s expand_aliases').",
			currentValue: config.shellCommandPrefix,
			submenu: textSubmenu("Shell command prefix"),
		},
		{
			id: "npm-command",
			label: "npm command",
			description:
				"Command used for npm package operations, space-separated argv (e.g. 'mise exec node@20 -- npm').",
			currentValue: config.npmCommand,
			submenu: textSubmenu("npm command"),
		},
		{
			id: "enable-analytics",
			label: "Analytics",
			description: "Share anonymous usage data (opt-in)",
			currentValue: config.enableAnalytics ? "true" : "false",
			values: ["true", "false"],
		},
	];
}

/**
 * Category tabs over the settings list: merges the selector's own items with the
 * hummin-only ones and splits them into one SettingsList per category.
 * Tab (or clicking a tab) switches the category.
 */
export class SettingsTabs extends Container {
	private readonly lists = new Map<string, SettingsList>();
	private activeCategoryId: string = SETTINGS_CATEGORIES[0].id;
	private readonly tabBar: SettingsTabBar;
	private readonly listChildIndex: number;
	private readonly categories: readonly SettingsCategory[];
	private readonly unplacedItemIds: string[];
	private readonly missingItemIds: string[];

	constructor(
		config: SettingsConfig,
		callbacks: SettingsCallbacks,
		items: SettingItem[],
		maxVisible: number,
		listTheme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: ConstructorParameters<typeof SettingsList>[5],
	) {
		super();
		const itemsById = new Map<string, SettingItem>();
		for (const item of [...items, ...createHumminItems(config, callbacks)]) {
			const description = DESCRIPTION_OVERRIDES[item.id];
			itemsById.set(item.id, description === undefined ? item : { ...item, description });
		}
		const placedIds = new Set(Object.values(CATEGORY_ITEM_IDS).flat());
		const unplaced = [...itemsById.values()].filter((item) => !placedIds.has(item.id));
		this.unplacedItemIds = unplaced.map((item) => item.id);
		this.missingItemIds = [...placedIds].filter((id) => !itemsById.has(id));
		// Items no category claims (e.g. new upstream settings) land in a tab shown only when needed.
		this.categories = unplaced.length > 0 ? [...SETTINGS_CATEGORIES, FALLBACK_CATEGORY] : SETTINGS_CATEGORIES;
		for (const category of this.categories) {
			const categoryItems =
				category.id === FALLBACK_CATEGORY.id
					? unplaced
					: CATEGORY_ITEM_IDS[category.id].flatMap((id) => itemsById.get(id) ?? []);
			this.lists.set(
				category.id,
				new SettingsList(categoryItems, maxVisible, listTheme, onChange, onCancel, options),
			);
		}

		this.tabBar = new SettingsTabBar(this.categories, this.activeCategoryId, (id) => this.switchCategory(id));
		this.addChild(this.tabBar);
		this.addChild(new Spacer(1));
		this.addChild(this.lists.get(this.activeCategoryId)!);
		this.listChildIndex = this.children.length - 1;
	}

	private switchCategory(id: string): void {
		if (id === this.activeCategoryId || !this.lists.has(id)) return;
		this.activeCategoryId = id;
		this.tabBar.setActiveId(id);
		this.children[this.listChildIndex] = this.lists.get(id)!;
	}

	/** Item ids no category claims, and category ids with no item (mainly for tests). */
	getPlacementProblems(): { unplaced: string[]; missing: string[] } {
		return { unplaced: this.unplacedItemIds, missing: this.missingItemIds };
	}

	/** Get the settings list of one category (mainly for tests). */
	getList(categoryId: string): SettingsList {
		return this.lists.get(categoryId)!;
	}

	/**
	 * Height reached in the tallest category at the given width (tab bar + list with
	 * its description and hints), so containers can reserve one stable block across
	 * tab switches.
	 */
	getMaxRenderHeight(width: number): number {
		let maxList = 0;
		for (const list of this.lists.values()) {
			maxList = Math.max(maxList, list.render(width).length);
		}
		return maxList + this.tabBar.render(width).length + 1;
	}

	/** Update an item's displayed value across all category lists. */
	updateValue(id: string, value: string): void {
		for (const list of this.lists.values()) {
			list.updateValue(id, value);
		}
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.input.tab")) {
			const index = this.categories.findIndex((category) => category.id === this.activeCategoryId);
			this.switchCategory(this.categories[(index + 1) % this.categories.length].id);
			return;
		}
		this.lists.get(this.activeCategoryId)?.handleInput(data);
	}
}
