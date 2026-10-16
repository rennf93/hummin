import { resetCapabilitiesCache, setCapabilityOverrides, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Keep in sync with baseConfig in settings-selector.test.ts.
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
	sessionShareDestination: "auto",
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

const IMAGE_ONLY_IDS = ["show-images", "image-width-cells"];

describe("settings tab placement", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		setCapabilityOverrides({});
		resetCapabilitiesCache();
	});

	for (const images of [true, false]) {
		it(`places every item in a category (images ${images ? "on" : "off"})`, () => {
			setCapabilityOverrides({ images: images ? "kitty" : null });
			const selector = new SettingsSelectorComponent(baseConfig, {} as unknown as SettingsCallbacks);
			const { unplaced, missing } = selector.getPlacementProblems();
			expect(
				unplaced,
				`Settings items without a category (shown in the "Other" tab): ${unplaced.join(", ")}. Place them in CATEGORY_ITEM_IDS in hummin-settings.ts.`,
			).toEqual([]);
			const deadIds = images ? missing : missing.filter((id) => !IMAGE_ONLY_IDS.includes(id));
			expect(
				deadIds,
				`CATEGORY_ITEM_IDS lists ids with no item: ${deadIds.join(", ")}. Remove them from hummin-settings.ts.`,
			).toEqual([]);
			expect(selector.getList("other")).toBeUndefined();
		});
	}
});
