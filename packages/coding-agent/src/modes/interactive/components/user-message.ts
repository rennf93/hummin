import { Container, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Compact local timestamp tag, e.g. "14:32" today, "2026-09-15 14:32" otherwise. */
export function formatMessageTimestamp(timestamp: number, now = new Date()): string {
	const date = new Date(timestamp);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	if (sameDay) return time;
	const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return `${day} ${time}`;
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	readonly scrollbarMarkerKind = "user";
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	// hummin overlay: the visible time tag, taken from the message's own epoch timestamp.
	private displayTimestamp?: number;
	private showTimestamp = true;
	private zoneLines?: { source: readonly string[]; lines: string[]; tagKey?: string };

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		displayTimestamp?: number,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.displayTimestamp = displayTimestamp;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setShowTimestamp(enabled: boolean): void {
		this.showTimestamp = enabled;
	}

	private rebuild(): void {
		this.clear();
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output.
		this.addChild(
			new Markdown(
				this.text,
				this.outputPad,
				1,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
					bgColor: (content: string) => theme.bg("userMessageBg", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform(
						"user",
						() => false,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
					),
				},
			),
		);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		// Container output is shared across frames; copy it once per change instead of mutating it.
		let output: readonly string[] = lines;
		const tagKey = `${this.showTimestamp}:${this.displayTimestamp ?? ""}`;
		if (this.showTimestamp && this.displayTimestamp !== undefined) {
			const tag = theme.fg("dim", formatMessageTimestamp(this.displayTimestamp));
			const padWidth = Math.max(0, width - 1 - visibleWidth(tag));
			const tagLine = truncateToWidth(" ".repeat(padWidth) + tag, width);
			output = [...lines, tagLine];
		}

		if (this.zoneLines?.source !== output || this.zoneLines.tagKey !== tagKey) {
			const zoned = [...output];
			zoned[0] = OSC133_ZONE_START + zoned[0];
			zoned[zoned.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + zoned[zoned.length - 1];
			this.zoneLines = { source: output, lines: zoned, tagKey };
		}
		return this.zoneLines.lines;
	}
}
