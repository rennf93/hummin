/**
 * renderer/tool/ToolCard: one protocol toolCall block plus its live tool_update
 * phases and matching toolResult. Collapsed row: state glyph, state label, tool
 * name, one-line args preview, duration. Expanded: specialization body (command
 * text, path with diff, question with choices, task preview, or raw args JSON),
 * pretty args JSON, argumentsError, and bounded result or partial result text.
 * Error states use --rc-bad plus a text label, never color alone.
 */
/// <reference lib="dom" />
import { useState } from "react";
import type { WireToolCallBlock } from "../../harness/replay-log.ts";
import { capForDisplay, SNIPPET_CAP_CHARS } from "../display-caps.ts";
import { TruncationNotice } from "../TruncationNotice.tsx";
import {
	argsPreview,
	boundedResult,
	deriveToolState,
	formatDuration,
	type ToolLiveState,
	type ToolResultView,
	prettyArgs,
	specializeTool,
	type ToolSpecialization,
} from "./tool-view.ts";

const STATE_GLYPH: Record<ToolCardStateKind, string> = {
	queued: "○",
	running: "◐",
	completed: "✓",
	error: "✗",
};

const STATE_LABEL: Record<ToolCardStateKind, string> = {
	queued: "queued",
	running: "running",
	completed: "done",
	error: "error",
};

type ToolCardStateKind = "queued" | "running" | "completed" | "error";

export function ToolCard({
	call,
	result,
	live,
}: {
	call: WireToolCallBlock;
	result?: ToolResultView;
	live?: ToolLiveState;
}) {
	const [expanded, setExpanded] = useState(false);
	const state = deriveToolState(call, result, live);
	const spec = specializeTool(call.name, call.arguments);
	const preview = argsPreview(call.name, call.arguments);
	const argsJson = prettyArgs(call.arguments);
	const outcome = result ?? (live?.partialResult !== undefined ? { text: live.partialResult } : undefined);
	const outcomeCapped = outcome === undefined ? undefined : boundedResult(outcome.text);
	const duration = state.durationMs !== undefined ? formatDuration(state.durationMs) : "";
	return (
		<article
			className={`rc-tool rc-tool-${state.kind}`}
			data-rc-tool-state={state.kind}
			data-rc-tool-name={call.name}
		>
			<button type="button" className="rc-tool-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
				<span className="rc-tool-glyph" aria-hidden="true">
					{STATE_GLYPH[state.kind]}
				</span>
				<span className="rc-tool-state">{STATE_LABEL[state.kind]}</span>
				<span className="rc-tool-name">{call.name === "" ? "tool" : call.name}</span>
				<span className="rc-tool-preview">{preview === "" ? "(no arguments)" : preview}</span>
				{duration !== "" && <span className="rc-tool-duration">{duration}</span>}
			</button>
			{!expanded && call.argumentsError !== undefined && (
				<div className="rc-tool-error rc-tool-error-inline">
					<span className="rc-tool-error-label">invalid arguments</span> {firstErrorLine(call.argumentsError)}
				</div>
			)}
			{expanded && (
				<div className="rc-tool-body">
					<SpecView spec={spec} />
					{argsJson.shown !== "{}" && (
						<section className="rc-tool-section">
							<div className="rc-tool-section-label">arguments</div>
							<pre className="rc-tool-args">{argsJson.shown}</pre>
							{argsJson.truncated && <TruncationNotice shown={argsJson.shown.length} total={argsJson.total} />}
						</section>
					)}
					{call.argumentsError !== undefined && (
						<div className="rc-tool-error">
							<span className="rc-tool-error-label">invalid arguments</span> {call.argumentsError}
						</div>
					)}
					{outcomeCapped !== undefined && (
						<section className="rc-tool-section">
							<div className="rc-tool-section-label">
								{result !== undefined ? "result" : "partial result"}
								{state.kind === "error" && <span className="rc-tool-error-label"> error</span>}
							</div>
							<pre className={state.kind === "error" ? "rc-tool-result rc-tool-result-error" : "rc-tool-result"}>
								{outcomeCapped.shown}
							</pre>
							{outcomeCapped.truncated && (
								<TruncationNotice shown={outcomeCapped.shown.length} total={outcomeCapped.total} />
							)}
						</section>
					)}
				</div>
			)}
		</article>
	);
}

function firstErrorLine(text: string, max = 160): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

function SpecView({ spec }: { spec: ToolSpecialization }) {
	switch (spec.kind) {
		case "command":
			return spec.command === "" ? null : (
				<section className="rc-tool-section">
					<div className="rc-tool-section-label">command</div>
					<CappedBlock className="rc-tool-command" text={spec.command} />
				</section>
			);
		case "read":
			return spec.path === "" ? null : (
				<section className="rc-tool-section">
					<div className="rc-tool-section-label">path</div>
					<div className="rc-tool-path">{spec.path}</div>
				</section>
			);
		case "write":
			return (
				<section className="rc-tool-section">
					<div className="rc-tool-section-label">path</div>
					<div className="rc-tool-path">{spec.path}</div>
					{spec.content !== "" && (
						<section className="rc-tool-section">
							<div className="rc-tool-section-label">content</div>
							<CappedBlock className="rc-tool-diff rc-tool-diff-add" text={diffPrefix("+", spec.content)} />
						</section>
					)}
				</section>
			);
		case "edit":
			return (
				<section className="rc-tool-section">
					<div className="rc-tool-section-label">path</div>
					<div className="rc-tool-path">{spec.path}</div>
					{spec.edits.map((edit, index) => (
						<div key={index} className="rc-tool-edits">
							<CappedBlock className="rc-tool-diff rc-tool-diff-del" text={diffPrefix("-", edit.oldText)} />
							<CappedBlock className="rc-tool-diff rc-tool-diff-add" text={diffPrefix("+", edit.newText)} />
						</div>
					))}
				</section>
			);
		case "task":
			return spec.preview === "" ? null : (
				<section className="rc-tool-section">
					<div className="rc-tool-section-label">task</div>
					<CappedBlock className="rc-tool-path" text={spec.preview} />
				</section>
			);
		case "question":
			return (
				<section className="rc-tool-section">
					<div className="rc-tool-section-label">question</div>
					<CappedBlock className="rc-tool-path" text={spec.question} />
					<ul className="rc-tool-choices">
						{spec.choices.map((choice, index) => (
							<li key={index}>{choice}</li>
						))}
					</ul>
				</section>
			);
		case "generic":
			return null;
	}
}

/** A preformatted content region capped at the snippet cap, with a notice when cut. */
function CappedBlock({ text, className }: { text: string; className: string }) {
	const capped = capForDisplay(text, SNIPPET_CAP_CHARS);
	return (
		<>
			<pre className={className}>{capped.shown}</pre>
			{capped.truncated && <TruncationNotice shown={capped.shown.length} total={capped.total} />}
		</>
	);
}

/** Prefixes each line with the diff marker so edit/write content reads as a textual diff. */
function diffPrefix(marker: string, text: string): string {
	const lines = text.split("\n");
	return lines.map((line) => `${marker} ${line}`).join("\n");
}
