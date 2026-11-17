/**
 * Pure helpers for the TODO reminder extension.
 *
 * The `todo` tool (registered by a user-level extension) writes its full list
 * into the tool result's `details` (`todos: [{ content, status }]`), so the
 * latest session state can be recovered by scanning the transcript backwards.
 * Everything here is defensive: session data is untrusted, and a malformed
 * `details` payload simply means "no known list", never a crash.
 */

import type { SessionEntry } from "../../core/session-manager.ts";

/** customType of the hidden reminder message injected into LLM context. */
export const TODO_REMINDER_CUSTOM_TYPE = "todo-reminder";

/** Turns without a `todo` tool result before a reminder fires. */
export const REMINDER_THRESHOLD = 5;

/** How many session entries the backwards scan examines at most. */
export const MAX_SCAN_ENTRIES = 200;

/** Hard cap for the injected reminder content, in characters. */
export const MAX_REMINDER_LENGTH = 400;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

export interface TodoSnapshot {
	todos: TodoItem[];
	pending: number;
	inProgress: number;
	completed: number;
}

/** Extract the todo list from a `todo` tool result's details, or undefined when absent/malformed. */
export function parseTodos(details: unknown): TodoItem[] | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const raw = (details as { todos?: unknown }).todos;
	if (!Array.isArray(raw)) return undefined;
	const todos: TodoItem[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const { content, status } = item as { content?: unknown; status?: unknown };
		if (typeof content !== "string" || content.length === 0) continue;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
		todos.push({ content, status });
	}
	return todos;
}

function summarize(todos: TodoItem[]): TodoSnapshot {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const todo of todos) {
		if (todo.status === "pending") pending += 1;
		else if (todo.status === "in_progress") inProgress += 1;
		else completed += 1;
	}
	return { todos, pending, inProgress, completed };
}

/**
 * Find the latest known todo state: scan entries backwards for the most recent
 * `todo` tool result (message entries only, at most MAX_SCAN_ENTRIES entries),
 * and summarize its list. Undefined when no list was seen in the window or the
 * latest list is empty (the todo tool was used to clear it).
 */
export function findLatestTodoSnapshot(entries: readonly SessionEntry[]): TodoSnapshot | undefined {
	let scanned = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (scanned >= MAX_SCAN_ENTRIES) return undefined;
		scanned += 1;
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (message.toolName !== "todo") continue;
		const todos = parseTodos(message.details);
		if (!todos || todos.length === 0) return undefined;
		return summarize(todos);
	}
	return undefined;
}

/**
 * Render the reminder: the in_progress items and the first pending item, plus
 * a staleness line naming the neglect. Hard-capped at MAX_REMINDER_LENGTH:
 * items are dropped first, and the staleness line always survives.
 */
export function formatTodoReminder(snapshot: TodoSnapshot, turnsSinceUpdate: number): string {
	const staleness = `TODO list not updated for ${turnsSinceUpdate} turns - update it now (todo tool) or mark it done.`;
	const header = `TODO reminder: ${snapshot.inProgress} in progress, ${snapshot.pending} pending.`;
	const items = [
		...snapshot.todos
			.filter((todo) => todo.status === "in_progress")
			.map((todo) => `- ${todo.content} (in progress)`),
		...snapshot.todos
			.filter((todo) => todo.status === "pending")
			.slice(0, 1)
			.map((todo) => `- ${todo.content} (pending)`),
	];
	const join = (lines: string[]) => lines.join("\n");
	const full = join([header, ...items, staleness]);
	if (full.length <= MAX_REMINDER_LENGTH) return full;
	for (let keep = items.length - 1; keep >= 0; keep--) {
		const candidate = join([header, ...items.slice(0, keep), staleness]);
		if (candidate.length <= MAX_REMINDER_LENGTH) return candidate;
	}
	// Header + staleness alone overflow: keep the tail of the header so the cap holds.
	const head = header.slice(Math.max(0, header.length - (MAX_REMINDER_LENGTH - staleness.length - 1)));
	return join([head, staleness]).slice(0, MAX_REMINDER_LENGTH);
}
