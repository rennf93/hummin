import { type Component, Markdown, type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import { DISPLAY_NAME } from "../../config.ts";
import type { AppKeybinding } from "../../core/keybindings.ts";
import { CollapsibleSection } from "./components/collapsible-section.ts";
import { keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface HumminHeaderText {
	collapsed: () => string;
	expanded: () => string;
}

// Exact pixel transcription of the red-throated hummingbird reference (native 16x12 grid, sampled colors, rendered at 2x scale).
const BIRD_PALETTE: Record<string, string> = {
	B: "#383838",
	D: "#388155",
	G: "#b3bab7",
	E: "#e65364",
	W: "#646367",
};
const BIRD: string[] = [
	"...BBBBB........",
	"...BDDWWB.......",
	"WWWWWEEEB.......",
	"...BEEEDBB......",
	"...WEEBDDBB.....",
	"...WGGDDDDBB....",
	"....BGGBDDDBB...",
	"....BBGBBBDDB...",
	".....BBGGGBDDB..",
	"......BBBGBBBDBB",
	"......BWBB..BBDB",
	".............BBB",
];

function rgb(hex: string): string {
	const value = parseInt(hex.slice(1), 16);
	return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

/** The bird logo with the product name and version beside its first line and the tagline beside its second. */
function buildLogo(version: string): string {
	const birdLines = BIRD.map((row) => {
		let line = "";
		for (const char of row) {
			const color = char === "." ? undefined : BIRD_PALETTE[char];
			line += color ? `\x1b[38;2;${rgb(color)}m██` : "  ";
		}
		return `${line}\x1b[0m`;
	});
	const nameLine = theme.bold(theme.fg("accent", DISPLAY_NAME)) + theme.fg("dim", ` v${version}`);
	const tagline = theme.fg("dim", "GLM-native coding agent");
	return [`${birdLines[0]}    ${nameLine}`, `${birdLines[1]}    ${tagline}`, ...birdLines.slice(2)].join("\n");
}

/** hummin's startup header: bird logo, version, key hints and onboarding line, in collapsed and expanded form. */
export function createHumminHeaderText(version: string): HumminHeaderText {
	const logo = buildLogo(version);
	// Build startup instructions using keybinding hint helpers
	const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

	const expandedInstructions = [
		hint("app.interrupt", "to interrupt"),
		hint("app.clear", "to clear"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		hint("app.exit", "to exit (empty)"),
		hint("app.suspend", "to suspend"),
		keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
		hint("app.thinking.cycle", "to cycle thinking level"),
		rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
		hint("app.model.select", "to select model"),
		hint("app.tools.expand", "to expand tools"),
		hint("app.thinking.toggle", "to expand thinking"),
		hint("app.editor.external", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		hint("app.message.followUp", "to queue follow-up"),
		hint("app.message.dequeue", "to edit all queued messages"),
		hint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
		rawKeyHint("drop files", "to attach"),
	].join("\n");
	const compactInstructions = [
		hint("app.interrupt", "interrupt"),
		hint("app.clear", "clear"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		hint("app.tools.expand", "all"),
	].join(theme.fg("muted", " · "));
	const onboarding = theme.fg("dim", `hummin can explain its own features and look up its docs - just ask.`);
	return {
		collapsed: () => `${logo}\n${compactInstructions}\n\n${onboarding}`,
		expanded: () => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
	};
}

/** The What's New changelog block: a one-line header that expands the changelog body on click. */
export function createWhatsNewSection(
	changelogMarkdown: string,
	fallbackVersion: string,
	markdownTheme: MarkdownTheme,
	requestRender: () => void,
): Component {
	const versionMatch = changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
	const latestVersion = versionMatch ? versionMatch[1] : fallbackVersion;
	const body = new Markdown(changelogMarkdown.trim(), 1, 0, markdownTheme);
	return new CollapsibleSection(
		(expanded, width) => {
			const glyph = expanded ? "▾" : "▸";
			const hint = expanded ? "click to collapse" : "click to expand";
			const header = `${glyph} ${theme.bold(theme.fg("accent", "What's New"))} ${theme.fg("dim", `· v${latestVersion} · ${hint}`)}`;
			return truncateToWidth(header, width);
		},
		body,
		requestRender,
	);
}
