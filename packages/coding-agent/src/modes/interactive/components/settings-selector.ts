import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model, type Transport } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	getKeybindings,
	Input,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { THINKING_LEVEL_OPTIONS } from "../../../core/defaults.ts";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import {
	CACHE_WARMING_MODES,
	type CacheWarmingMode,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type MermaidRenderingMode,
	type TuiMode,
	type WarningSettings,
} from "../../../core/settings-manager.ts";
import { getSettingsListTheme, parseAutoThemeSetting, type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText, keyText } from "./keybinding-hints.ts";
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";

const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

const WS_CONNECT_TIMEOUT_CHOICES = [
	{ label: "5 sec", timeoutMs: 5_000 },
	{ label: "10 sec", timeoutMs: 10_000 },
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const CLEAR_OVERRIDE_VALUE = "__clear__";

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

export interface SettingsCategory {
	id: string;
	label: string;
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
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
];

export interface SettingsConfig {
	autoCompact: boolean;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	streamingSubmitMode: "steer" | "followUp";
	messageTimestamps: boolean;
	compactPrompt: boolean;
	transport: Transport;
	httpIdleTimeoutMs: number;
	cacheWarmingMode: CacheWarmingMode;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	warnings: WarningSettings;
	providersShowAll: boolean;
	retryEnabled: boolean;
	memoryEnabled: boolean;
	memoryMode: "lesson" | "vault";
	memoryVaultDir: string;
	memoryProvider: string;
	memoryModelId: string;
	localInstances: string[];
	fleetAutoStart: boolean;
	editorMode: "default" | "vim";
	externalEditor: string;
	websocketConnectTimeoutMs: number | undefined;
	httpProxy: string;
	shellPath: string;
	shellCommandPrefix: string;
	npmCommand: string;
	enableAnalytics: boolean;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onStreamingSubmitModeChange: (mode: "steer" | "followUp") => void;
	onMessageTimestampsChange: (enabled: boolean) => void;
	onCompactPromptChange: (enabled: boolean) => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onCacheWarmingModeChange: (mode: CacheWarmingMode) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
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
	onEditorModeChange: (mode: "default" | "vim") => void;
	onExternalEditorChange: (command: string) => void;
	onWebSocketConnectTimeoutMsChange: (timeoutMs: number | undefined) => void;
	onHttpProxyChange: (proxy: string) => void;
	onShellPathChange: (path: string) => void;
	onShellCommandPrefixChange: (prefix: string) => void;
	onNpmCommandChange: (command: string[]) => void;
	onEnableAnalyticsChange: (enabled: boolean) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return "none";
	return `${count} configured`;
}

function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes, currentTheme),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Free-text submenu: input pre-filled with the current value.
 * Enter saves, Esc cancels.
 */
class TextInputSubmenu extends Container {
	private input: Input;

	constructor(
		title: string,
		description: string,
		initialValue: string,
		placeholder: string,
		onSave: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.input = new Input({ prompt: "> ", placeholder });
		this.input.setValue(initialValue);
		this.input.onSubmit = (value) => onSave(value.trim());
		this.input.onEscape = () => onCancel();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

interface TabRect {
	id: string;
	row: number;
	start: number;
	end: number;
}

/** Category tab bar row above the settings list. Click a tab to switch. */
class SettingsTabBar implements Component {
	private readonly tabs: readonly SettingsCategory[];
	private activeId: string;
	private readonly onSelect: (id: string) => void;
	private rects: TabRect[] = [];

	invalidate(): void {
		// No cached state to invalidate
	}

	constructor(tabs: readonly SettingsCategory[], activeId: string, onSelect: (id: string) => void) {
		this.tabs = tabs;
		this.activeId = activeId;
		this.onSelect = onSelect;
	}

	setActiveId(id: string): void {
		this.activeId = id;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const rects: TabRect[] = [];
		const gap = 2;
		let rowText = "  ";
		let x = 2;
		let row = 0;

		for (const tab of this.tabs) {
			const labelWidth = visibleWidth(tab.label);
			if (x + labelWidth > width && x > 2) {
				lines.push(truncateToWidth(rowText, width));
				row += 1;
				rowText = "  ";
				x = 2;
			}
			rects.push({ id: tab.id, row, start: x, end: x + labelWidth });
			rowText += this.activeId === tab.id ? theme.bold(theme.fg("accent", tab.label)) : theme.fg("muted", tab.label);
			rowText += " ".repeat(gap);
			x += labelWidth + gap;
		}

		if (rowText.length > 2) {
			const hint = ` · ${keyText("tui.input.tab")} to switch`;
			if (visibleWidth(rowText) + visibleWidth(hint) <= width) {
				rowText += hint;
			}
		}

		lines.push(truncateToWidth(rowText, width));
		this.rects = rects;
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const rect = this.rects.find((r) => r.row === event.y && event.x >= r.start && event.x < r.end);
		if (!rect || rect.id === this.activeId) return undefined;
		this.onSelect(rect.id);
		return { handled: true };
	}
}

/**
 * Main settings selector component: categorized tabs, one settings list per category.
 * Tab (or clicking a tab) switches the category; Esc cancels the whole selector.
 */
export class SettingsSelectorComponent extends Container {
	private lists = new Map<string, SettingsList>();
	private activeCategoryId = SETTINGS_CATEGORIES[0].id;
	private tabBar: SettingsTabBar;
	private listChildIndex = 0;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		let currentWarnings = { ...config.warnings };
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		const defaultModelByValue = new Map(
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

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

		const general: SettingItem[] = [
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "message-timestamps",
				label: "Message timestamps",
				description: "Show local timestamps below user and extension messages.",
				currentValue: config.messageTimestamps ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "skill-commands",
				label: "Skill commands",
				description: "Register skills as /skill:name commands",
				currentValue: config.enableSkillCommands ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
		];

		const agent: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
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
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Steering delivery: 'one-at-a-time' delivers one and waits for a response; 'all' delivers all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "retry-enabled",
				label: "Retry on failure",
				description: "Automatically retry failed agent turns with exponential backoff",
				currentValue: config.retryEnabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "cache-warming-mode",
				label: "Cache warming",
				description:
					"off; streaming while the agent runs; idle also between runs while continuation stays profitable",
				currentValue: config.cacheWarmingMode,
				values: [...CACHE_WARMING_MODES],
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Show transcript notices for cache costs and provider recovery diagnostics",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
		];

		const models: SettingItem[] = [
			{
				id: "default-thinking-level",
				label: "Default thinking level",
				description:
					"Global default reasoning effort for models that support thinking; also applies to the current session",
				currentValue: config.thinkingLevel,
				values: [...(config.availableThinkingLevels ?? THINKING_LEVEL_OPTIONS)],
			},
			{
				id: "model-thinking",
				label: "Default thinking level per model",
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				submenu: (_currentValue, done) => {
					const steps: SteppedSubmenuStep[] = [
						{
							key: "model",
							title: "Per-Model Thinking Level",
							description: "Select a model to configure",
							options: () => {
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									const aKey = modelSettingKey(a);
									const bKey = modelSettingKey(b);
									if (aKey === currentModelKey) return -1;
									if (bKey === currentModelKey) return 1;
									if (aKey === currentDefaultModelKey) return -1;
									if (bKey === currentDefaultModelKey) return 1;
									return a.provider.localeCompare(b.provider);
								});
								const items: SelectItem[] = sorted.map((model) => {
									const key = modelSettingKey(model);
									const override = currentModelThinkingLevels[key];
									return {
										value: key,
										label: modelItemLabel(model),
										description: override ?? undefined,
									};
								});
								if (items.length === 0) {
									items.push({
										value: "__none__",
										label: "No models available",
										description: "Log in to a provider or configure an API key first",
									});
								}
								return items;
							},
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							searchable: true,
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							key: "level",
							title: (ctx) => {
								const m = defaultModelByValue.get(ctx.model);
								return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
							},
							description: "Select default thinking level for this model",
							options: (ctx) => {
								const model = defaultModelByValue.get(ctx.model);
								if (!model) return [];
								const levels = (
									model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
								) as ThinkingLevel[];
								const activeLevel = currentModelThinkingLevels[ctx.model];
								const items: SelectItem[] = levels.map((level) => ({
									value: level,
									label: `${level === activeLevel ? "✓ " : "  "}${level}`,
									description: THINKING_DESCRIPTIONS[level],
								}));
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									items.push({
										value: CLEAR_OVERRIDE_VALUE,
										label: "  (clear override)",
										description: `Revert to global default (${config.thinkingLevel})`,
									});
								}
								return items;
							},
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

					return new SteppedSubmenu(
						steps,
						(selections) => {
							const model = defaultModelByValue.get(selections.model);
							if (!model) return;
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								delete currentModelThinkingLevels[selections.model];
							} else {
								callbacks.onModelThinkingLevelChange(
									model.provider,
									model.id,
									selections.level as ThinkingLevel,
								);
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						() => {
							done(summary());
						},
						{ loop: true },
					);
				},
			},
			{
				id: "providers-show-all",
				label: "Show all providers",
				description: "/login lists every known provider instead of the curated set plus already-configured ones",
				currentValue: config.providersShowAll ? "true" : "false",
				values: ["true", "false"],
			},
		];

		const memory: SettingItem[] = [
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
		];

		const fleet: SettingItem[] = [
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
		];

		const editor: SettingItem[] = [
			{
				id: "editor-mode",
				label: "Editor mode",
				description:
					"default: standard keys · vim: modal editing (applies to new sessions; HUMMIN_VIM=1 takes precedence)",
				currentValue: config.editorMode,
				values: ["default", "vim"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "editor-padding",
				label: "Editor padding",
				description: "Horizontal padding for input editor (0-3)",
				currentValue: String(config.editorPaddingX),
				values: ["0", "1", "2", "3"],
			},
			{
				id: "autocomplete-max-visible",
				label: "Autocomplete max items",
				description: "Max visible items in autocomplete dropdown (3-20)",
				currentValue: String(config.autocompleteMaxVisible),
				values: ["3", "5", "7", "10", "15", "20"],
			},
			{
				id: "show-hardware-cursor",
				label: "Show hardware cursor",
				description: "Show the terminal cursor while still positioning it for IME support",
				currentValue: config.showHardwareCursor ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "external-editor",
				label: "External editor",
				description: "Command for the external editor keybinding. Empty falls back to VISUAL/EDITOR.",
				currentValue: config.externalEditor,
				submenu: textSubmenu("External editor command"),
			},
		];

		const terminal: SettingItem[] = [
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; fullscreen mode is experimental",
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			{
				id: "fullscreen-copy-on-select",
				label: "Fullscreen copy on select",
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
				currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "clear-on-shrink",
				label: "Clear on shrink",
				description: "Clear empty rows when content shrinks (may cause flicker)",
				currentValue: config.clearOnShrink ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "terminal-progress",
				label: "Terminal progress",
				description: "Show OSC 9;4 progress indicators in the terminal tab bar",
				currentValue: config.showTerminalProgress ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "output-padding",
				label: "Output padding",
				description: "Horizontal padding for user messages, assistant messages, and thinking",
				currentValue: String(config.outputPad),
				values: ["0", "1"],
			},
		];

		if (supportsImages) {
			terminal.splice(
				2,
				0,
				{
					id: "show-images",
					label: "Show images",
					description: "Render images inline in terminal",
					currentValue: config.showImages ? "true" : "false",
					values: ["true", "false"],
				},
				{
					id: "image-width-cells",
					label: "Image width",
					description: "Preferred inline image width in terminal cells",
					currentValue: String(config.imageWidthCells),
					values: ["60", "80", "120"],
				},
			);
		}
		terminal.push(
			{
				id: "auto-resize-images",
				label: "Auto-resize images",
				description: "Resize large images to 2000x2000 max for better model compatibility",
				currentValue: config.autoResizeImages ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "block-images",
				label: "Block images",
				description: "Prevent images from being sent to LLM providers",
				currentValue: config.blockImages ? "true" : "false",
				values: ["true", "false"],
			},
		);

		const network: SettingItem[] = [
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
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
		];

		const shell: SettingItem[] = [
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
		];

		const privacy: SettingItem[] = [
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "enable-analytics",
				label: "Analytics",
				description: "Share anonymous usage data (opt-in)",
				currentValue: config.enableAnalytics ? "true" : "false",
				values: ["true", "false"],
			},
		];

		const itemsByCategory: Record<string, SettingItem[]> = {
			general,
			agent,
			models,
			memory,
			fleet,
			editor,
			terminal,
			network,
			shell,
			privacy,
		};

		const onChange = (id: string, newValue: string) => {
			switch (id) {
				case "quiet-startup":
					callbacks.onQuietStartupChange(newValue === "true");
					break;
				case "collapse-changelog":
					callbacks.onCollapseChangelogChange(newValue === "true");
					break;
				case "message-timestamps":
					callbacks.onMessageTimestampsChange(newValue === "true");
					break;
				case "skill-commands":
					callbacks.onEnableSkillCommandsChange(newValue === "true");
					break;
				case "default-project-trust": {
					const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
					if (defaultProjectTrust) {
						callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
					}
					break;
				}
				case "autocompact":
					callbacks.onAutoCompactChange(newValue === "true");
					break;
				case "compact-prompt":
					callbacks.onCompactPromptChange(newValue === "true");
					break;
				case "streaming-submit-mode":
					callbacks.onStreamingSubmitModeChange(newValue as "steer" | "followUp");
					break;
				case "steering-mode":
					callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
					break;
				case "follow-up-mode":
					callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
					break;
				case "retry-enabled":
					callbacks.onRetryEnabledChange(newValue === "true");
					break;
				case "cache-warming-mode":
					callbacks.onCacheWarmingModeChange(newValue as CacheWarmingMode);
					break;
				case "hide-thinking":
					callbacks.onHideThinkingBlockChange(newValue === "true");
					break;
				case "mermaid-rendering":
					callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
					break;
				case "cache-miss-notices":
					callbacks.onShowCacheMissNoticesChange(newValue === "true");
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
				case "editor-mode":
					callbacks.onEditorModeChange(newValue as "default" | "vim");
					break;
				case "double-escape-action":
					callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
					break;
				case "tree-filter-mode":
					callbacks.onTreeFilterModeChange(
						newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
					);
					break;
				case "editor-padding":
					callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
					break;
				case "autocomplete-max-visible":
					callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
					break;
				case "show-hardware-cursor":
					callbacks.onShowHardwareCursorChange(newValue === "true");
					break;
				case "external-editor":
					callbacks.onExternalEditorChange(newValue);
					break;
				case "theme":
					callbacks.onThemeChange(newValue);
					break;
				case "tui-mode":
					callbacks.onTuiModeChange(newValue as TuiMode);
					break;
				case "fullscreen-exit-output":
					callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
					break;
				case "fullscreen-scrollbar":
					callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
					break;
				case "fullscreen-copy-on-select":
					callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
					break;
				case "clear-on-shrink":
					callbacks.onClearOnShrinkChange(newValue === "true");
					break;
				case "terminal-progress":
					callbacks.onShowTerminalProgressChange(newValue === "true");
					break;
				case "output-padding":
					callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
					break;
				case "show-images":
					callbacks.onShowImagesChange(newValue === "true");
					break;
				case "image-width-cells":
					callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
					break;
				case "auto-resize-images":
					callbacks.onAutoResizeImagesChange(newValue === "true");
					break;
				case "block-images":
					callbacks.onBlockImagesChange(newValue === "true");
					break;
				case "transport":
					callbacks.onTransportChange(newValue as Transport);
					break;
				case "http-idle-timeout": {
					const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
					if (choice) {
						callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
					}
					break;
				}
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
				case "install-telemetry":
					callbacks.onEnableInstallTelemetryChange(newValue === "true");
					break;
				case "enable-analytics":
					callbacks.onEnableAnalyticsChange(newValue === "true");
					break;
			}
		};

		for (const category of SETTINGS_CATEGORIES) {
			this.lists.set(
				category.id,
				new SettingsList(itemsByCategory[category.id], 10, getSettingsListTheme(), onChange, callbacks.onCancel, {
					enableSearch: true,
				}),
			);
		}

		this.tabBar = new SettingsTabBar(SETTINGS_CATEGORIES, this.activeCategoryId, (id) => this.switchCategory(id));

		this.addChild(new DynamicBorder());
		this.addChild(this.tabBar);
		this.addChild(new Spacer(1));
		this.addChild(this.lists.get(this.activeCategoryId)!);
		this.listChildIndex = this.children.length - 1;
		this.addChild(new DynamicBorder());
	}

	private switchCategory(id: string): void {
		if (id === this.activeCategoryId || !this.lists.has(id)) return;
		this.activeCategoryId = id;
		this.tabBar.setActiveId(id);
		this.children[this.listChildIndex] = this.lists.get(id)!;
	}

	/** Get the settings list of one category (mainly for tests). */
	getList(categoryId: string): SettingsList {
		return this.lists.get(categoryId)!;
	}

	/** Update an item's displayed value across all category lists. */
	updateValue(id: string, value: string): void {
		for (const list of this.lists.values()) {
			list.updateValue(id, value);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.input.tab")) {
			const index = SETTINGS_CATEGORIES.findIndex((category) => category.id === this.activeCategoryId);
			this.switchCategory(SETTINGS_CATEGORIES[(index + 1) % SETTINGS_CATEGORIES.length].id);
			return;
		}
		this.lists.get(this.activeCategoryId)?.handleInput(data);
	}
}
