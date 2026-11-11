/**
 * renderer/tool/tool-view: pure view model for tool cards: state derivation from
 * result and live phases, per-tool specializations, one-line previews, bounded
 * text, and duration formatting. Argument shapes follow the recorded fixture
 * corpus (bash command, read/write/edit path, task prompt, ask_user question +
 * choices) plus hummin's own tools (vault, todo, monitor, task_status,
 * task_cancel); every field read is a trust-boundary narrowing of wire data.
 */
import type { ToolUpdatePayload, WireAgentMessage, WireTranscriptEntry } from "../../harness/replay-log.ts";
import { type CappedText, capForDisplay, SNIPPET_CAP_CHARS } from "../display-caps.ts";

export type ToolStateKind = "queued" | "running" | "completed" | "error";

/** Live phase state from tool_update events, keyed by toolCallId. */
export interface ToolLiveState {
	phase: "start" | "update" | "end";
	partialResult?: string;
	isError?: boolean;
	durationMs?: number;
}

/** Matching toolResult entry for a tool call block. */
export interface ToolResultView {
	isError: boolean;
	durationMs?: number;
	text: string;
}

export interface ToolCardState {
	kind: ToolStateKind;
	durationMs?: number;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	text: string;
	status: TodoStatus;
}

/** One label/value pair of a compact meta line. */
export interface ToolMetaItem {
	label: string;
	value: string;
}

export type MonitorAction = "start" | "status" | "stop";

export type ToolSpecialization =
	| { kind: "command"; command: string }
	| { kind: "read"; path: string }
	| { kind: "write"; path: string; content: string }
	| { kind: "edit"; path: string; edits: { oldText: string; newText: string }[] }
	| { kind: "task"; preview: string; meta: ToolMetaItem[] }
	| { kind: "vault"; query: string }
	| { kind: "todo"; todos: TodoItem[] }
	| { kind: "monitor"; action: MonitorAction | undefined; command: string; label: string; meta: ToolMetaItem[] }
	| { kind: "task_status"; taskId: string }
	| { kind: "task_cancel"; taskId: string }
	| { kind: "question"; question: string; choices: string[] }
	| { kind: "generic" };

/** Derives the card state: a call with argumentsError is an error regardless of later
 * phases; a matching result wins over live phases; queued means no outcome yet. */
export function deriveToolState(
	call: { argumentsError?: string },
	result?: ToolResultView,
	live?: ToolLiveState,
): ToolCardState {
	if (call.argumentsError !== undefined) return { kind: "error", durationMs: result?.durationMs ?? live?.durationMs };
	if (result !== undefined) return { kind: result.isError ? "error" : "completed", durationMs: result.durationMs };
	if (live !== undefined) {
		if (live.phase === "end")
			return { kind: live.isError === true ? "error" : "completed", durationMs: live.durationMs };
		return { kind: "running", durationMs: live.durationMs };
	}
	return { kind: "queued" };
}

/** Maps a tool name plus wire arguments to the rendering specialization. Unknown tools
 * fall through to the generic card, whose expanded body is the raw args JSON. */
export function specializeTool(name: string, args: Record<string, unknown>): ToolSpecialization {
	switch (name) {
		case "bash":
		case "exec":
			return { kind: "command", command: stringArg(args, "command") };
		case "read":
			return { kind: "read", path: stringArg(args, "path") };
		case "write":
			return { kind: "write", path: stringArg(args, "path"), content: stringArg(args, "content") };
		case "edit":
			return { kind: "edit", path: stringArg(args, "path"), edits: editPairs(args) };
		case "task":
			return {
				kind: "task",
				preview: stringArg(args, "prompt"),
				meta: metaItems([
					["persona", stringArg(args, "persona")],
					["model", stringArg(args, "model")],
					["thinking", stringArg(args, "thinking")],
					["background", typeof args.background === "boolean" ? (args.background ? "yes" : "no") : ""],
					["timeout", durationArg(args, "timeout_sec")],
				]),
			};
		case "vault":
			return { kind: "vault", query: stringArg(args, "query") };
		case "todo":
			return { kind: "todo", todos: todoItems(args) };
		case "monitor":
			return {
				kind: "monitor",
				action:
					args.action === "start" || args.action === "status" || args.action === "stop" ? args.action : undefined,
				command: stringArg(args, "command"),
				label: stringArg(args, "name") || stringArg(args, "command") || stringArg(args, "id"),
				meta: metaItems([
					["match", stringArg(args, "match")],
					["interval", durationArg(args, "interval_sec")],
					["timeout", durationArg(args, "timeout_sec")],
				]),
			};
		case "task_status":
			return { kind: "task_status", taskId: stringArg(args, "task_id") };
		case "task_cancel":
			return { kind: "task_cancel", taskId: stringArg(args, "task_id") };
		case "ask_user":
			return { kind: "question", question: stringArg(args, "question"), choices: stringArrayArg(args, "choices") };
		default:
			return { kind: "generic" };
	}
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value : "";
}

/** Seconds argument as a short "30s" value; empty when absent or not a finite number. */
function durationArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? formatDuration(value * 1000) : "";
}

function metaItems(pairs: [string, string][]): ToolMetaItem[] {
	return pairs.filter(([, value]) => value !== "").map(([label, value]) => ({ label, value }));
}

function todoItems(args: Record<string, unknown>): TodoItem[] {
	const value = args.todos;
	if (!Array.isArray(value)) return [];
	const items: TodoItem[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const status = record.status;
		if (typeof record.text !== "string" || record.text === "") continue;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
		items.push({ text: record.text, status });
	}
	return items;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
	const value = args[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function editPairs(args: Record<string, unknown>): { oldText: string; newText: string }[] {
	const value = args.edits;
	if (!Array.isArray(value)) return [];
	const pairs: { oldText: string; newText: string }[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.oldText !== "string" || typeof record.newText !== "string") continue;
		pairs.push({ oldText: record.oldText, newText: record.newText });
	}
	return pairs;
}

/** One-line collapsed-row preview: the specialization's headline value, or a JSON
 * glance for generic and empty arguments. */
export function argsPreview(name: string, args: Record<string, unknown>): string {
	const spec = specializeTool(name, args);
	let headline = "";
	switch (spec.kind) {
		case "command":
			headline = spec.command;
			break;
		case "read":
			headline = spec.path;
			break;
		case "write":
			headline = spec.path;
			break;
		case "edit":
			headline = spec.path;
			break;
		case "task":
			headline = spec.preview;
			break;
		case "vault":
			headline = spec.query;
			break;
		case "todo":
			headline =
				spec.todos.length === 0
					? "No todos"
					: `${spec.todos.filter((todo) => todo.status === "completed").length} of ${spec.todos.length} done`;
			break;
		case "monitor":
			headline = spec.label;
			break;
		case "task_status":
		case "task_cancel":
			headline = spec.taskId;
			break;
		case "question":
			headline = spec.question;
			break;
		case "generic":
			headline = "";
			break;
	}
	if (headline === "") headline = jsonGlance(args);
	return oneLine(headline);
}

function jsonGlance(args: Record<string, unknown>): string {
	const raw = stringifyArgs(args);
	return raw.length > 120 ? `${raw.slice(0, 119)}...` : raw;
}

function stringifyArgs(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args, null, 2) ?? "";
	} catch {
		return "{ args are not representable as JSON }";
	}
}

/** Pretty-printed args JSON for the expanded card, render-capped. */
export function prettyArgs(args: Record<string, unknown>): CappedText {
	return capForDisplay(stringifyArgs(args), SNIPPET_CAP_CHARS);
}

/** Bounded result text for the expanded card. */
export function boundedResult(text: string): CappedText {
	return capForDisplay(text, SNIPPET_CAP_CHARS);
}

/** Formats a duration for a card label: milliseconds below a second, then seconds,
 * then minutes. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) {
		const rounded = Math.round(seconds * 10) / 10;
		return `${rounded}s`;
	}
	const minutes = Math.round(seconds / 6) / 10;
	return `${minutes}m`;
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

/** First line of a text, for compact toolResult rows. */
export function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0] ?? "";
	return oneLine(line, max);
}

/** Collects toolResult entries keyed by their toolCallId so tool call cards can show
 * outcome, error, and duration without a second pass by the caller. */
export function collectToolResults(entries: readonly WireTranscriptEntry[]): Map<string, ToolResultView> {
	const map = new Map<string, ToolResultView>();
	for (const entry of entries) {
		const message: WireAgentMessage = entry.message;
		if (message.role !== "toolResult" || message.toolCallId === undefined) continue;
		map.set(message.toolCallId, {
			isError: message.isError === true,
			durationMs: message.durationMs,
			text: messageText(message),
		});
	}
	return map;
}

function messageText(message: WireAgentMessage): string {
	const parts: string[] = [];
	for (const block of message.blocks) {
		if (block.type === "text" || block.type === "thinking") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Ids of every toolCall block in the entries: a toolResult whose toolCallId is in this
 * set is shown by its tool row, so the transcript hides the separate result entry. */
export function collectToolCallIds(entries: readonly WireTranscriptEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		for (const block of entry.message.blocks) {
			if (block.type === "toolCall") ids.add(block.id);
		}
	}
	return ids;
}

const MONITOR_VERBS: Record<MonitorAction | "unknown", { past: string; present: string }> = {
	start: { past: "Started monitor", present: "Starting monitor" },
	status: { past: "Checked monitor", present: "Checking monitor" },
	stop: { past: "Stopped monitor", present: "Stopping monitor" },
	unknown: { past: "Monitor", present: "Monitor" },
};

const VERBS: Record<Exclude<ToolSpecialization["kind"], "generic" | "monitor">, { past: string; present: string }> = {
	command: { past: "Ran", present: "Running" },
	read: { past: "Read", present: "Reading" },
	write: { past: "Wrote", present: "Writing" },
	edit: { past: "Edited", present: "Editing" },
	task: { past: "Started task", present: "Starting task" },
	vault: { past: "Searched vault", present: "Searching vault" },
	todo: { past: "Updated todos", present: "Updating todos" },
	task_status: { past: "Checked task", present: "Checking task" },
	task_cancel: { past: "Cancelled task", present: "Cancelling task" },
	question: { past: "Asked", present: "Asking" },
};

/** Human verb for a tool row: present form until the call has an outcome, past form
 * after; unspecialized tools show their own name. A monitor's verb depends on its
 * action, so pass the specialization for it. */
export function toolVerb(
	kind: ToolSpecialization["kind"],
	state: ToolStateKind,
	name: string,
	spec?: ToolSpecialization,
): string {
	if (kind === "generic") return name === "" ? "tool" : name;
	const action = spec?.kind === "monitor" ? spec.action : undefined;
	const verb = kind === "monitor" ? MONITOR_VERBS[action ?? "unknown"] : VERBS[kind];
	return state === "completed" || state === "error" ? verb.past : verb.present;
}

/** Folds one tool_update event into the live phase map, copy-on-write. */
export function applyToolUpdate(
	map: ReadonlyMap<string, ToolLiveState>,
	payload: ToolUpdatePayload,
): Map<string, ToolLiveState> {
	const next = new Map(map);
	const live: ToolLiveState = { phase: payload.phase };
	if (payload.partialResult !== undefined) live.partialResult = payload.partialResult;
	if (payload.isError !== undefined) live.isError = payload.isError;
	if (payload.durationMs !== undefined) live.durationMs = payload.durationMs;
	next.set(payload.toolCallId, live);
	return next;
}
