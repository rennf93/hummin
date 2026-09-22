import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Frames a selector rendered as a centered overlay with themed side rails, so
 * the dialog reads as a solid panel against the transcript behind it. The
 * wrapped component keeps its own top/bottom borders; the panel only adds the
 * left/right edges and shifts mouse coordinates accordingly.
 */
export class Panel implements Component {
	private readonly child: Component;
	private readonly color: (s: string) => string;

	constructor(child: Component, color?: (s: string) => string) {
		this.child = child;
		this.color = color ?? ((s) => theme.fg("border", s));
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const out: string[] = [];
		for (const line of this.child.render(inner)) {
			const clipped = truncateToWidth(line, inner, "");
			const pad = Math.max(0, inner - visibleWidth(clipped));
			out.push(`${this.color("│")}${clipped}${" ".repeat(pad)}${this.color("│")}`);
		}
		return out;
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Swallow events on the rail columns; shift the rest into child space.
		if (event.x <= 0 || event.x >= event.width - 1) {
			return event.type === "wheel" ? undefined : { handled: true };
		}
		return this.child.handleMouse?.({ ...event, x: event.x - 1 });
	}
}
