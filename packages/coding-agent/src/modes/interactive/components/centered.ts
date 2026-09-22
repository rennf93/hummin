import { type Component, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** Options for {@link Centered}. */
export interface CenteredOptions {
	/** Height floor in lines, evaluated per render (so resizes apply). The block
	 * is padded to this height just before its trailing frame rule(s), keeping
	 * the content top-anchored and the frame at a fixed position. */
	minHeight?: (width: number) => number;
	/** Width cap in columns, evaluated per render. The child renders at this
	 * capped width (so long values truncate instead of stretching the block),
	 * and the capped block is centered in the terminal. */
	maxWidth?: (width: number) => number;
}

/**
 * Centers a selector in the editor container and keeps its size stable:
 *
 * - Horizontal: the child renders at a capped width (`maxWidth`), so long
 *   values truncate instead of stretching rows to the terminal edge; the whole
 *   block (frame rules included) is then shifted right by half the leftover
 *   terminal width, keeping its internal column alignment.
 * - Vertical: the block never shrinks below `minHeight(width)` nor below the
 *   tallest state seen since mount (the ratchet), so switching tabs, picking
 *   items, or filtering does not shift the layout. Padding is inserted before
 *   the trailing frame rule(s), so the frame stays put and the gap opens up
 *   between the content and the bottom rule.
 *
 * Mouse events are shifted back into child coordinates; clicks on the gutters
 * are swallowed.
 */
export class Centered implements Component {
	private readonly child: Component;
	private readonly minHeight: ((width: number) => number) | undefined;
	private readonly maxWidth: ((width: number) => number) | undefined;
	private lastPad = 0;
	private lastWidth: number | undefined;
	private maxSeen = 0;

	constructor(child: Component, options?: CenteredOptions) {
		this.child = child;
		this.minHeight = options?.minHeight;
		this.maxWidth = options?.maxWidth;
	}

	private static isRuleLine(line: string): boolean {
		const bare = line.replace(ANSI_SGR, "").trim();
		return bare.length > 0 && /^[─━═-]+$/.test(bare);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const inner = Math.max(1, Math.min(width, this.maxWidth?.(width) ?? width));
		if (this.lastWidth !== inner) {
			this.lastWidth = inner;
			this.maxSeen = 0;
		}
		const lines = this.child.render(inner);
		this.maxSeen = Math.max(this.maxSeen, lines.length);
		// Some children (e.g. text inputs) pad lines with trailing spaces out to
		// the full width; ignore that when measuring the content block.
		let maxContent = 0;
		for (const line of lines) maxContent = Math.max(maxContent, visibleWidth(line.replace(/\s+$/, "")));
		this.lastPad = Math.floor(Math.max(0, width - maxContent) / 2);
		if (this.lastPad !== 0) {
			const pad = " ".repeat(this.lastPad);
			for (let i = 0; i < lines.length; i++) lines[i] = `${pad}${lines[i]}`;
		}
		// Vertical floor: pad just before the trailing frame rule(s) so the frame
		// stays at a fixed position while the gap opens above it.
		const isRule = lines.map((line) => Centered.isRuleLine(line));
		let trailingRules = 0;
		for (let i = lines.length - 1; i >= 0 && isRule[i]; i--) trailingRules++;
		const floor = Math.max(this.minHeight?.(inner) ?? 0, this.maxSeen);
		const padCount = Math.max(0, floor - lines.length);
		if (padCount > 0) {
			const blanks: string[] = [];
			for (let i = 0; i < padCount; i++) blanks.push("");
			lines.splice(lines.length - trailingRules, 0, ...blanks);
		}
		return lines;
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.lastPad === 0) return this.child.handleMouse?.(event);
		// Swallow clicks on the left gutter; shift the rest into child space.
		if (event.x < this.lastPad) {
			return event.type === "wheel" ? undefined : { handled: true };
		}
		return this.child.handleMouse?.({ ...event, x: event.x - this.lastPad });
	}
}
