/**
 * renderer/tool/ToolCard: one protocol toolCall block plus its live tool_update
 * phases and matching toolResult, as a quiet one-line row: status icon, verb,
 * mono preview, duration, chevron. Expanding opens a Disclosure holding a sunken
 * well with the specialization body (command text, path with diff, question with
 * choices, task preview, vault query, todo checklist, monitor command, or raw args
 * JSON), pretty args JSON, argumentsError and
 * bounded result or partial result text. The state word stays in the DOM as a
 * visually hidden span so status is never colour alone.
 */
/// <reference lib="dom" />
import { useId, useRef, useState } from "react";
import type { WireToolCallBlock } from "../../harness/replay-log.ts";
import { Disclosure } from "../../ui/Disclosure.tsx";
import { Icon, type IconName } from "../../ui/Icon.tsx";
import { Shimmer } from "../../ui/Shimmer.tsx";
import { capForDisplay, SNIPPET_CAP_CHARS } from "../display-caps.ts";
import { TruncationNotice } from "../TruncationNotice.tsx";
import {
	argsPreview,
	boundedResult,
	deriveToolState,
	formatDuration,
	prettyArgs,
	specializeTool,
	toolVerb,
	type ToolLiveState,
	type ToolResultView,
	type TodoItem,
	type ToolMetaItem,
	type ToolSpecialization,
	type ToolStateKind,
} from "./tool-view.ts";
import "./tool.css";

export const STATE_ICON: Record<ToolStateKind, IconName> = {
	queued: "clock",
	running: "spinner",
	completed: "check",
	error: "x",
};

export const STATE_LABEL: Record<ToolStateKind, string> = {
	queued: "queued",
	running: "running",
	completed: "done",
	error: "error",
};

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
	const bodyId = useId();
	// wire arguments are untrusted: null, arrays and primitives read as no arguments
	const args = isRecord(call.arguments) ? call.arguments : {};
	const state = deriveToolState(call, result, live);
	// Pop only on a transition seen after mount, so replayed rows never animate.
	const firstKind = useRef(state.kind);
	const transitioned = state.kind !== firstKind.current;
	const spec = specializeTool(call.name, args);
	const preview = argsPreview(call.name, args);
	const duration = state.durationMs !== undefined ? formatDuration(state.durationMs) : "";
	const running = state.kind === "running";
	const verb = toolVerb(spec.kind, state.kind, call.name, spec);
	return (
		<article
			className={`rc-tool rc-tool-is-${state.kind}`}
			data-rc-tool-state={state.kind}
			data-rc-tool-name={call.name}
		>
			<button
				type="button"
				className="rc-tool-row"
				aria-expanded={expanded}
				aria-controls={expanded ? bodyId : undefined}
				onClick={() => setExpanded(!expanded)}
			>
				<span className="rc-tool-glyph">
					<Icon key={state.kind} name={STATE_ICON[state.kind]} className={transitioned ? "rc-pop" : undefined} />
				</span>
				<span className="rc-tool-state">{STATE_LABEL[state.kind]}</span>
				<span className="rc-tool-name">{running ? <Shimmer>{verb}</Shimmer> : verb}</span>
				<span className="rc-tool-preview">{preview === "" ? "(no arguments)" : preview}</span>
				{duration !== "" && (
					<span className={transitioned ? "rc-tool-duration rc-enter" : "rc-tool-duration"}>{duration}</span>
				)}
				<Icon name="chevron-right" className="rc-chevron" />
			</button>
			{!expanded && call.argumentsError !== undefined && (
				<div className="rc-tool-error rc-tool-error-inline">
					<span className="rc-tool-error-label">invalid arguments</span> {firstErrorLine(call.argumentsError)}
				</div>
			)}
			<Disclosure open={expanded}>
				<ToolBody id={bodyId} args={args} call={call} spec={spec} state={state.kind} result={result} live={live} />
			</Disclosure>
		</article>
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ToolBody({
	id,
	args,
	call,
	spec,
	state,
	result,
	live,
}: {
	id: string;
	args: Record<string, unknown>;
	call: WireToolCallBlock;
	spec: ToolSpecialization;
	state: ToolStateKind;
	result?: ToolResultView;
	live?: ToolLiveState;
}) {
	const argsJson = prettyArgs(args);
	const outcome = result ?? (live?.partialResult !== undefined ? { text: live.partialResult } : undefined);
	const outcomeCapped = outcome === undefined ? undefined : boundedResult(outcome.text);
	return (
		<div className="rc-tool-body" id={id}>
			<SpecView spec={spec} />
			{argsJson.shown !== "{}" && (
				<section className="rc-tool-section">
					<div className="rc-label rc-tool-section-label">arguments</div>
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
					<div className="rc-label rc-tool-section-label">
						{result !== undefined ? "result" : "partial result"}
						{state === "error" && <span className="rc-tool-error-label"> error</span>}
					</div>
					<pre className={state === "error" ? "rc-tool-result rc-tool-result-error" : "rc-tool-result"}>
						{outcomeCapped.shown}
					</pre>
					{outcomeCapped.truncated && <TruncationNotice shown={outcomeCapped.shown.length} total={outcomeCapped.total} />}
				</section>
			)}
		</div>
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
					<div className="rc-label rc-tool-section-label">command</div>
					<CappedBlock className="rc-tool-command" text={spec.command} />
				</section>
			);
		case "read":
			return spec.path === "" ? null : (
				<section className="rc-tool-section">
					<div className="rc-label rc-tool-section-label">path</div>
					<div className="rc-tool-path">{spec.path}</div>
				</section>
			);
		case "write":
			return (
				<section className="rc-tool-section">
					<div className="rc-label rc-tool-section-label">path</div>
					<div className="rc-tool-path">{spec.path}</div>
					{spec.content !== "" && (
						<section className="rc-tool-section">
							<div className="rc-label rc-tool-section-label">content</div>
							<CappedBlock className="rc-tool-diff rc-tool-diff-add" text={diffPrefix("+", spec.content)} />
						</section>
					)}
				</section>
			);
		case "edit":
			return (
				<section className="rc-tool-section">
					<div className="rc-label rc-tool-section-label">path</div>
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
			return spec.preview === "" && spec.meta.length === 0 ? null : (
				<section className="rc-tool-section">
					{spec.preview !== "" && (
						<>
							<div className="rc-label rc-tool-section-label">task</div>
							<CappedBlock className="rc-tool-path" text={spec.preview} />
						</>
					)}
					<MetaLine items={spec.meta} />
				</section>
			);
		case "vault":
			return spec.query === "" ? null : (
				<section className="rc-tool-section">
					<div className="rc-label rc-tool-section-label">query</div>
					<CappedBlock className="rc-tool-path" text={spec.query} />
				</section>
			);
		case "todo":
			return (
				<section className="rc-tool-section">
					<TodoList todos={spec.todos} />
				</section>
			);
		case "monitor":
			return spec.command === "" && spec.meta.length === 0 ? null : (
				<section className="rc-tool-section">
					{spec.command !== "" && (
						<>
							<div className="rc-label rc-tool-section-label">command</div>
							<CappedBlock className="rc-tool-command" text={spec.command} />
						</>
					)}
					<MetaLine items={spec.meta} />
				</section>
			);
		case "task_status":
		case "task_cancel":
			return null;
		case "question":
			return (
				<section className="rc-tool-section">
					<div className="rc-label rc-tool-section-label">question</div>
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

const TODO_ICON: Record<TodoItem["status"], IconName> = {
	completed: "check",
	in_progress: "chevron-right",
	pending: "circle",
};

function TodoList({ todos }: { todos: readonly TodoItem[] }) {
	if (todos.length === 0) return <div className="rc-tool-empty">No todos</div>;
	return (
		<ul className="rc-todo-list">
			{todos.map((todo, index) => (
				<li key={index} className="rc-todo" data-rc-todo-status={todo.status}>
					<Icon name={TODO_ICON[todo.status]} className="rc-todo-icon" />
					<span className="rc-todo-text">{todo.text}</span>
					{todo.status === "in_progress" && <span className="rc-todo-state">in progress</span>}
				</li>
			))}
		</ul>
	);
}

function MetaLine({ items }: { items: readonly ToolMetaItem[] }) {
	if (items.length === 0) return null;
	return (
		<div className="rc-tool-meta">
			{items.map((item) => (
				<span key={item.label} className="rc-tool-meta-item">
					<span className="rc-label">{item.label}</span> <span className="rc-mono">{item.value}</span>
				</span>
			))}
		</div>
	);
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
