import { beforeAll, describe, expect, it } from "vitest";
import { BashEditorLineHighlighter } from "../src/modes/interactive/hummin-bash-editor-line-highlighter.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("BashEditorLineHighlighter", () => {
	beforeAll(() => initTheme("dark"));

	it("highlights a continuation line without a leading ! while bash mode is on", () => {
		const highlighter = new BashEditorLineHighlighter();
		const line = "echo $HOME && if true; then echo hi; fi";
		expect(highlighter.highlight(line, true)).not.toBe(line);
	});

	it("highlights nothing when bash mode is off", () => {
		const highlighter = new BashEditorLineHighlighter();
		const line = "!echo $HOME && if true; then echo hi; fi";
		expect(highlighter.highlight(line, false)).toBe(line);
	});
});
