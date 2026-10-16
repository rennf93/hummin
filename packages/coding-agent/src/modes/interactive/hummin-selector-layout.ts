import type { Component, Terminal } from "@earendil-works/pi-tui";
import { Centered } from "./components/centered.ts";

/** Width cap for selector content: long values truncate instead of stretching the block to the terminal edge, and every selector shares the same cap. */
const SELECTOR_MAX_WIDTH = 100;

/** Upper bound for reserved selector height, so small terminals keep most of the transcript visible. */
function selectorHeightCap(terminal: Terminal): number {
	return Math.max(0, Math.min(24, terminal.rows - 8));
}

/** Wrap a selector so it is centered, width-capped and keeps a stable height. */
export function centerSelector(component: Component, terminal: Terminal): Component {
	// Selectors that know their tallest state (tabbed views) reserve it upfront; the ratchet in Centered covers the rest (filtering, submenus).
	const getMaxHeight = (component as { getMaxRenderHeight?: (width: number) => number }).getMaxRenderHeight;
	const minHeight = getMaxHeight
		? (width: number) => Math.min(getMaxHeight.call(component, width), selectorHeightCap(terminal))
		: // Reserved height floor for selectors without a known maximum: proportional to the viewport, capped by selectorHeightCap.
			() => Math.min(Math.round(terminal.rows * 0.4), selectorHeightCap(terminal));
	return new Centered(component, { minHeight, maxWidth: () => SELECTOR_MAX_WIDTH });
}
