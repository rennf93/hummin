import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const theme = {
	borderColor: (s: string) => s,
	fg: (_key: string, s: string) => s,
} as unknown as EditorTheme;

function makeEditor(): { editor: CustomEditor; interrupts(): number } {
	let interrupts = 0;
	const editor = new CustomEditor(
		{ requestRender() {} } as unknown as TUI,
		theme,
		KeybindingsManager.create("/tmp/hummin-vim-test-agent"),
		{ vimMode: true },
	);
	editor.onAction("app.interrupt", () => {
		interrupts += 1;
	});
	return { editor, interrupts: () => interrupts };
}

describe("custom editor vim escape routing", () => {
	it("INSERT escape switches to NORMAL without interrupting", () => {
		const { editor, interrupts } = makeEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		expect(editor.getText()).toBe("hi");
		expect(editor.isVimInsert()).toBe(true);
		editor.handleInput("\x1b");
		expect(editor.isVimInsert()).toBe(false);
		expect(editor.getVimIndicator()).toContain("NORMAL");
		expect(interrupts()).toBe(0);
	});

	it("NORMAL escape keeps the interrupt behavior", () => {
		const { editor, interrupts } = makeEditor();
		editor.handleInput("\x1b"); // INSERT -> NORMAL
		editor.handleInput("\x1b"); // NORMAL -> app.interrupt
		expect(interrupts()).toBe(1);
	});

	it("x deletes in NORMAL mode through the full input path", () => {
		const { editor } = makeEditor();
		editor.handleInput("hi");
		editor.handleInput("\x1b");
		editor.handleInput("x");
		expect(editor.getText()).toBe("h");
	});
});
