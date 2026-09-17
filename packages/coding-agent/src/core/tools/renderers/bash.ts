/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { formatToolLabel, getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

export const BASH_UPDATE_THROTTLE_MS = 100;
type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};
class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
/** Dim `· duration` suffix for the call row; live while the command runs. */
function formatShellStatusSuffix(
	state: { startedAt?: number; endedAt?: number } | undefined,
	isError: boolean,
): string {
	if (!state || state.startedAt === undefined) return "";
	const end = state.endedAt ?? Date.now();
	let suffix = `  ${theme.fg("muted", `· ${formatDuration(end - state.startedAt)}`)}`;
	if (isError) suffix += ` ${theme.fg("error", "(failed)")}`;
	return suffix;
}
function formatShellCall(
	args: { command?: string; timeout?: number } | undefined,
	toolName: string,
	state: { startedAt?: number; endedAt?: number } | undefined,
	isError: boolean,
): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return (
		theme.fg("toolTitle", theme.bold(formatToolLabel(toolName))) +
		commandDisplay +
		timeoutSuffix +
		formatShellStatusSuffix(state, isError)
	);
}
function lastNonEmptyLine(text: string): string | undefined {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim().length > 0) return lines[i];
	}
	return undefined;
}
function shellTruncationWarnings(
	truncation: BashToolDetails["truncation"],
	fullOutputPath: string | undefined,
): string | undefined {
	if (!truncation?.truncated && !fullOutputPath) return undefined;
	const warnings: string[] = [];
	if (fullOutputPath) {
		warnings.push(`Full output: ${fullOutputPath}`);
	}
	if (truncation?.truncated) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			warnings.push(
				`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
			);
		}
	}
	return theme.fg("warning", `[${warnings.join(". ")}]`);
}
function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	isError: boolean,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	// While running: a single dim tail line so progress is visible without a wall of output.
	if (options.isPartial) {
		const tail = lastNonEmptyLine(output);
		if (tail) {
			component.addChild({
				render: (width: number) => [truncateToWidth(theme.fg("muted", `│ ${tail}`), width, "…")],
				invalidate: () => {},
			});
		}
		return;
	}

	// Collapsed and successful: the call row carries the summary; only surface truncation.
	if (!options.expanded && !isError) {
		const warning = shellTruncationWarnings(truncation, fullOutputPath);
		if (warning) component.addChild(new Text(`\n${warning}`, 0, 0));
		return;
	}

	// Expanded or failed: full output plus truncation warnings.
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		component.addChild(new Text(`\n${styledOutput}`, 0, 0));
	}
	const warning = shellTruncationWarnings(truncation, fullOutputPath);
	if (warning) component.addChild(new Text(`\n${warning}`, 0, 0));
}

/** Shell renderers are shared by shell tools, which differ only in the tool name they display. */
export function createShellRenderers(toolName: string): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	interface ShellRenderState {
		startedAt?: number;
		endedAt?: number;
		interval?: ReturnType<typeof setInterval>;
	}
	return {
		renderCall(args, _theme, context) {
			const state = context.state as ShellRenderState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatShellCall(
					args as { command?: string; timeout?: number } | undefined,
					toolName,
					state,
					context.isError,
				),
			);
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state as ShellRenderState;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages, context.isError);
			component.invalidate();
			return component;
		},
	};
}
