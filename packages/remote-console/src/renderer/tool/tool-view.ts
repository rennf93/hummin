/**
 * renderer/tool/tool-view: pure view model for tool cards: state derivation from
 * result and live phases, per-tool specializations, one-line previews, bounded
 * text, and duration formatting. Argument shapes follow the recorded fixture
 * corpus (bash command, read/write/edit path, task prompt, ask_user question +
 * choices); every field read is a trust-boundary narrowing of wire data.
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

export type ToolSpecialization =
	| { kind: "command"; command: string }
	| { kind: "read"; path: string }
	| { kind: "write"; path: string; content: string }
	| { kind: "edit"; path: string; edits: { oldText: string; newText: string }[] }
	| { kind: "task"; preview: string }
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
			return { kind: "task", preview: stringArg(args, "prompt") };
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
