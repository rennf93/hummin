import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { CollapsibleSection } from "../src/modes/interactive/components/collapsible-section.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function clickAt(y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 3,
		y,
		screenX: 3,
		screenY: y,
		width: 80,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

function makeSection(): CollapsibleSection {
	const body = new Text("BODY CONTENT LINE", 1, 0);
	return new CollapsibleSection(
		(expanded) => (expanded ? "▾ Header · click to collapse" : "▸ Header · click to expand"),
		body,
	);
}

describe("CollapsibleSection", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders only the header while collapsed", () => {
		const section = makeSection();
		expect(section.collapsed).toBe(true);
		const lines = section.render(80);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0]);
		expect(text).toContain("Header");
		expect(text).toContain("click to expand");
		expect(text).not.toContain("BODY CONTENT LINE");
	});

	it("expands on header click and collapses again", () => {
		const section = makeSection();

		section.handleMouse(clickAt(0));
		expect(section.collapsed).toBe(false);
		const expanded = section.render(80).map(stripAnsi);
		expect(expanded[0]).toContain("click to collapse");
		expect(expanded.some((line) => line.includes("BODY CONTENT LINE"))).toBe(true);

		section.handleMouse(clickAt(0));
		expect(section.collapsed).toBe(true);
		expect(section.render(80)).toHaveLength(1);
	});

	it("ignores clicks on body rows while expanded", () => {
		const section = makeSection();
		section.handleMouse(clickAt(0));

		section.handleMouse(clickAt(1));
		expect(section.collapsed).toBe(false);

		section.handleMouse(clickAt(5));
		expect(section.collapsed).toBe(false);
	});

	it("ignores non-click events on the header", () => {
		const section = makeSection();
		const press = { ...clickAt(0), type: "press" as const };
		expect(section.handleMouse(press)?.handled).toBe(true);
		expect(section.collapsed).toBe(true);

		const release = { ...clickAt(0), type: "release" as const };
		expect(section.handleMouse(release)?.handled).toBe(true);
		expect(section.collapsed).toBe(true);

		const move = { ...clickAt(0), type: "move" as const, button: "none" as const };
		expect(section.handleMouse(move)).toBeUndefined();
		expect(section.collapsed).toBe(true);
	});

	it("truncates the header to width", () => {
		const section = new CollapsibleSection(
			(expanded) => (expanded ? "▾" : "▸") + "x".repeat(200),
			new Text("b", 0, 0),
		);
		const lines = section.render(40);
		expect(lines).toHaveLength(1);
	});
});
