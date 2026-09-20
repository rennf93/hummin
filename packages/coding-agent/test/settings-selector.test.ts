import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const baseConfig = {
	availableDefaultModels: [],
	availableThinkingLevels: [],
	modelThinkingLevels: {},
	availableThemes: [],
	showImages: true,
	imageWidthCells: 60,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	steeringMode: "all",
	followUpMode: "all",
	streamingSubmitMode: "steer",
	messageTimestamps: false,
	compactPrompt: false,
	transport: "auto",
	httpIdleTimeoutMs: 300000,
	thinkingLevel: "medium",
	currentTheme: "dark",
	terminalTheme: "dark",
	hideThinkingBlock: false,
	mermaidRenderingMode: "streaming",
	showCacheMissNotices: false,
	collapseChangelog: false,
	enableInstallTelemetry: true,
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	showHardwareCursor: true,
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	quietStartup: true,
	defaultProjectTrust: "ask",
	clearOnShrink: false,
	showTerminalProgress: false,
	tuiMode: "regular",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	warnings: {},
	providersShowAll: false,
	retryEnabled: true,
	memoryEnabled: false,
	memoryMode: "lesson",
	memoryVaultDir: "",
	memoryProvider: "zai",
	memoryModelId: "glm-5.3-flash",
	localInstances: [],
	fleetAutoStart: false,
	editorMode: "default",
	externalEditor: "",
	websocketConnectTimeoutMs: undefined,
	httpProxy: "",
	shellPath: "",
	shellCommandPrefix: "",
	npmCommand: "",
	enableAnalytics: false,
} as unknown as SettingsConfig;

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			...baseConfig,
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getList("terminal");
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("cycles streaming submission and timestamp settings", () => {
		const onStreamingSubmitModeChange = vi.fn();
		const onMessageTimestampsChange = vi.fn();
		const config = {
			...baseConfig,
			streamingSubmitMode: "steer",
			messageTimestamps: true,
			availableDefaultModels: [],
			modelThinkingLevels: {},
		} as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, {
			onStreamingSubmitModeChange,
			onMessageTimestampsChange,
		} as unknown as SettingsCallbacks).getList("agent");
		list.selectItem("streaming-submit-mode");
		list.handleInput("\r");
		list.handleInput("\r");
		expect(onStreamingSubmitModeChange.mock.calls.flat()).toEqual(["followUp", "steer"]);
		const generalList = new SettingsSelectorComponent(config, {
			onStreamingSubmitModeChange,
			onMessageTimestampsChange,
		} as unknown as SettingsCallbacks).getList("general");
		generalList.selectItem("message-timestamps");
		generalList.handleInput("\r");
		generalList.handleInput("\r");
		expect(onMessageTimestampsChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			...baseConfig,
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getList("terminal");

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("    Automatic");
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			...baseConfig,
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getList("terminal");

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model")!;
		const modelKey = `${model.provider}/${model.id}`;
		const config = {
			...baseConfig,
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getList("models");

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
	});
});
