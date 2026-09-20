import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

/**
 * Human-readable tool labels for transcript rows. Each tool keeps its own
 * distinct label; anything not listed here is auto-title-cased from its
 * snake_case name (e.g. `task_status` -> `Task Status`).
 */
const TOOL_LABEL_OVERRIDES: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "List",
	todo: "Plan",
	task: "Task",
	task_status: "Task Status",
	task_cancel: "Task Cancel",
	vault: "Vault Search",
	monitor: "Monitor",
	web_fetch: "Fetch",
	web_search: "Search",
};

/** Title-case a single tool-name word (used by the auto fallback). */
function titleCaseWord(word: string): string {
	return word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * Format a tool name for display in a transcript row: one distinct label per
 * tool, Title Case. Call sites separate the label from the row content with a
 * two-space gap; labels are not padded to a shared column.
 */
export function formatToolLabel(toolName: string): string {
	const override = TOOL_LABEL_OVERRIDES[toolName.toLowerCase()];
	return override ?? toolName.split(/[_-]/).map(titleCaseWord).join(" ");
}

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
