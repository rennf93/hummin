/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { type Component, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { formatToolLabel, getTextOutput, invalidArgText, startToolTimer, str, toolTimerText } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

export const BASH_UPDATE_THROTTLE_MS = 100;
/**
 * Dim `· duration` suffix for the call row; live while the command runs. `timerText` is upstream's
 * shared tool timer (Elapsed while running, Took once settled, from the recorded duration when known)
 * shown on the hummin dim dot suffix instead of a separate result line.
 */
function formatShellStatusSuffix(timerText: string | undefined, isError: boolean): string {
	if (!timerText) return "";
	let suffix = `  ${theme.fg("muted", `· ${timerText}`)}`;
	if (isError) suffix += ` ${theme.fg("error", "(failed)")}`;
	return suffix;
}
/** Collapse a command to the single-line form shown on the collapsed row. */
function collapseCommandToSingleLine(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}
/**
 * Call-row component for shell tools. The collapsed row is always ONE line: the
 * padded label, a single separator, and the command truncated to the viewport
 * width so multi-line commands never spill onto extra lines. Expanded, the full
 * multi-line command is shown.
 */
class ShellCallRenderComponent implements Component {
	expanded = false;
	private expandedText: Text;
	buildCollapsedLine: (width: number) => string;
	constructor() {
		this.expandedText = new Text("", 0, 0);
		this.buildCollapsedLine = () => "";
	}
	setExpandedText(text: string): void {
		this.expandedText.setText(text);
	}
	render(width: number): string[] {
		if (this.expanded) return this.expandedText.render(width);
		return [this.buildCollapsedLine(width)];
	}
	invalidate(): void {
		this.expandedText.invalidate();
	}
}
function buildShellCallComponent(
	component: ShellCallRenderComponent | undefined,
	args: { command?: string; timeout?: number } | undefined,
	toolName: string,
	timerText: string | undefined,
	isError: boolean,
	expanded: boolean,
): ShellCallRenderComponent {
	const shellComponent = component ?? new ShellCallRenderComponent();
	const label = theme.fg("toolTitle", theme.bold(formatToolLabel(toolName)));
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const suffix = timeoutSuffix + formatShellStatusSuffix(timerText, isError);
	if (command === null) {
		const invalid = invalidArgText(theme);
		shellComponent.setExpandedText(`${label}  ${invalid}${timeoutSuffix}`);
		shellComponent.buildCollapsedLine = () => `${label}  ${invalid}${suffix}`;
		return shellComponent;
	}
	if (!command) {
		const placeholder = theme.fg("toolOutput", "...");
		shellComponent.setExpandedText(`${label}  ${placeholder}${timeoutSuffix}`);
		shellComponent.buildCollapsedLine = () => `${label}  ${placeholder}${suffix}`;
		return shellComponent;
	}
	// Expanded: the full multi-line command (wrapped by Text).
	shellComponent.setExpandedText(`${label}  ${command}${timeoutSuffix}`);
	// Collapsed: one line - label, separator, command trimmed to width.
	const singleLine = collapseCommandToSingleLine(command);
	shellComponent.buildCollapsedLine = (width: number) => {
		const prefixWidth = visibleWidth(label) + 2;
		const budget = Math.max(0, width - prefixWidth - visibleWidth(suffix));
		const commandDisplay = truncateToWidth(singleLine, budget, "…");
		return `${label}  ${commandDisplay}${suffix}`;
	};
	shellComponent.expanded = expanded;
	return shellComponent;
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
	component: Container,
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
	return {
		renderCall(args, _theme, context) {
			startToolTimer(context);
			const component =
				(context.lastComponent as ShellCallRenderComponent | undefined) ?? new ShellCallRenderComponent();
			buildShellCallComponent(
				component,
				args as { command?: string; timeout?: number } | undefined,
				toolName,
				toolTimerText(context, context.isPartial),
				context.isError,
				context.expanded,
			);
			return component;
		},
		renderResult(result, options, _theme, context) {
			// Keeps the shared timer's per-second redraw and end time in step with the result.
			toolTimerText(context, options.isPartial);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages, context.isError);
			component.invalidate();
			return component;
		},
	};
}
