import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { formatMessageTimestamp, UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-history-test-"));
	vi.stubEnv(ENV_AGENT_DIR, directory);
	initTheme("dark");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function historyEditor(cwd: string) {
	const target = {
		sessionManager: { getCwd: () => cwd },
		editor: { addToHistory: vi.fn() },
		defaultEditor: { setHistory: vi.fn() },
		get promptHistoryFile(): string {
			return Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "promptHistoryFile")!.get!.call(this);
		},
	};
	const remember = Reflect.get(InteractiveMode.prototype, "rememberPromptHistory") as (
		this: typeof target,
		text: string,
	) => void;
	const load = Reflect.get(InteractiveMode.prototype, "loadPromptHistory") as (this: typeof target) => void;
	return { target, remember: (text: string) => remember.call(target, text), load: () => load.call(target) };
}

test("loads bounded, deduplicated history per project and recovers from corrupt history", () => {
	const editor = historyEditor("/project/one");
	editor.remember("first");
	writeFileSync(
		editor.target.promptHistoryFile,
		JSON.stringify(Array.from({ length: 600 }, (_, index) => `prompt ${index}`)),
	);
	editor.remember("  prompt 4  ");
	const saved = JSON.parse(readFileSync(editor.target.promptHistoryFile, "utf8")) as string[];
	expect(saved).toHaveLength(500);
	expect(saved[0]).toBe("prompt 4");
	expect(saved.filter((text) => text === "prompt 4")).toHaveLength(1);
	const reopened = historyEditor("/project/one");
	reopened.load();
	expect(reopened.target.defaultEditor.setHistory).toHaveBeenLastCalledWith(saved);
	const other = historyEditor("/project/two");
	other.load();
	expect(other.target.defaultEditor.setHistory).toHaveBeenLastCalledWith([]);
	writeFileSync(editor.target.promptHistoryFile, "{broken");
	editor.load();
	expect(editor.target.defaultEditor.setHistory).toHaveBeenLastCalledWith([]);
	editor.remember("recovered");
	expect(JSON.parse(readFileSync(editor.target.promptHistoryFile, "utf8"))).toEqual(["recovered"]);
});

test("records built-in commands before they return from submission", async () => {
	const target = {
		defaultEditor: { onSubmit: undefined as ((text: string) => Promise<void>) | undefined },
		editor: { setText: vi.fn() },
		rememberPromptHistory: vi.fn(),
		showSettingsSelector: vi.fn(),
	};
	const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: typeof target) => void;
	setup.call(target);
	await target.defaultEditor.onSubmit!(" /settings ");
	expect(target.rememberPromptHistory).toHaveBeenCalledWith("/settings");
	expect(target.showSettingsSelector).toHaveBeenCalledOnce();
});

test("persists streaming and timestamp preferences across settings reload", async () => {
	const settings = SettingsManager.create(directory, join(directory, "agent"));
	expect(settings.getStreamingSubmitMode()).toBe("steer");
	expect(settings.getMessageTimestamps()).toBe(true);
	settings.setStreamingSubmitMode("followUp");
	settings.setMessageTimestamps(false);
	await settings.flush();
	expect(settings.drainErrors()).toEqual([]);
	const reopened = SettingsManager.create(directory, join(directory, "agent"));
	expect(reopened.getStreamingSubmitMode()).toBe("followUp");
	expect(reopened.getMessageTimestamps()).toBe(false);
});

test("toggles timestamps on existing user and extension messages", () => {
	const timestamp = new Date(2020, 0, 2, 14, 32).getTime();
	const tag = formatMessageTimestamp(timestamp);
	const components = [
		new UserMessageComponent("user text", undefined, 1, [], timestamp),
		new CustomMessageComponent({
			role: "custom",
			customType: "test",
			content: "extension text",
			display: true,
			timestamp,
		}),
	];
	for (const component of components) {
		component.setShowTimestamp(false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain(tag);
		component.setShowTimestamp(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain(tag);
		component.setShowTimestamp(false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain(tag);
	}
});
