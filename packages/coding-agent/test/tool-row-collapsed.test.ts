import { describe, expect, it } from "vitest";
import { formatToolLabel } from "../src/core/tools/render-utils.ts";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import { editRenderers } from "../src/core/tools/renderers/edit.ts";
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme(undefined, false);

function renderContext(overrides: Record<string, unknown> = {}) {
	return {
		state: {} as any,
		lastComponent: undefined,
		cwd: "/tmp",
		toolCallId: "t1",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		invalidate: () => {},
		...overrides,
	} as any;
}

describe("collapsed bash call row", () => {
	const bash = createShellRenderers("bash");
	const multiLineCommand = "npm run check &&\nnpm test &&\nnode scripts/foo.mjs --bar baz --qux quux";

	it("renders exactly one line: newlines collapsed to spaces", () => {
		const component = bash.renderCall!({ command: multiLineCommand }, theme, renderContext());
		const lines = component.render(120);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0]).trimEnd();
		expect(text).toContain("npm run check && npm test &&");
		expect(text).not.toMatch(/\n/);
	});

	it("truncates the command to the terminal width, keeping the label and suffix", () => {
		const component = bash.renderCall!({ command: multiLineCommand, timeout: 30 }, theme, renderContext());
		const width = 60;
		const lines = component.render(width);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0]).trimEnd();
		expect(text.startsWith(`${formatToolLabel("bash")} npm run check`)).toBe(true);
		expect(text.endsWith("(timeout 30s)")).toBe(true);
		expect(text.length).toBeLessThanOrEqual(width);
	});

	it("shows the full multi-line command when expanded", () => {
		const component = bash.renderCall!({ command: multiLineCommand }, theme, renderContext({ expanded: true }));
		const lines = component
			.render(120)
			.map((l) => stripAnsi(l).trimEnd())
			.filter((l) => l.length > 0);
		expect(lines.join("\n")).toContain(multiLineCommand);
	});

	it("uses a single separator between the padded label and the command", () => {
		const component = bash.renderCall!({ command: "echo hi" }, theme, renderContext());
		const text = stripAnsi(component.render(120)[0]).trimEnd();
		const label = formatToolLabel("bash");
		expect(text.startsWith(`${label} echo hi`)).toBe(true);
	});
});

describe("collapsed write/edit call rows", () => {
	it("write renders one line with the padded label and a single separator", () => {
		const component = writeRenderers.renderCall!({ path: "/tmp/foo.ts", content: "hello" }, theme, renderContext());
		const lines = component.render(120);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0]).trimEnd();
		expect(text.startsWith(`${formatToolLabel("write")} /tmp/foo.ts`)).toBe(true);
	});

	it("edit renders one line with the padded label and a single separator", () => {
		const component = editRenderers.renderCall!(
			{ path: "/tmp/foo.ts", edits: [{ oldText: "a", newText: "b" }] },
			theme,
			renderContext(),
		);
		const lines = component.render(120);
		expect(lines).toHaveLength(3); // Box(1,1) vertical padding
		const text = stripAnsi(lines[1]).trimEnd();
		expect(text.startsWith(` ${formatToolLabel("edit")} /tmp/foo.ts`)).toBe(true);
	});
});
