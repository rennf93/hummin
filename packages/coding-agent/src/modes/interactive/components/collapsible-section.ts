import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

/**
 * One-line header that toggles a body component on click. Collapsed renders
 * only the header; expanded renders header plus body. Clicks on body rows
 * pass through untouched so text selection keeps working.
 */
export class CollapsibleSection implements Component {
	collapsed = true;
	private renderHeader: (expanded: boolean, width: number) => string;
	private body: Component;
	private onToggle: () => void;

	constructor(
		renderHeader: (expanded: boolean, width: number) => string,
		body: Component,
		onToggle: () => void = () => {},
	) {
		this.renderHeader = renderHeader;
		this.body = body;
		this.onToggle = onToggle;
	}

	/** No-op: the header line is rebuilt on every render. */
	invalidate(): void {}

	render(width: number): string[] {
		const header = this.renderHeader(!this.collapsed, width);
		if (this.collapsed) return [header];
		return [header, ...this.body.render(width)];
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.button !== "left" || event.y !== 0) return undefined;
		// Claim the press so the screen synthesizes a click on this component;
		// the toggle itself happens on the completed click.
		if (event.type === "press" || event.type === "release") return { handled: true };
		if (event.type !== "click") return undefined;
		this.collapsed = !this.collapsed;
		this.onToggle();
		return { handled: true };
	}
}
