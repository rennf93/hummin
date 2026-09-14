/**
 * hummin-todos: visible plan for multi-step work.
 *
 * Registers a `todo` tool the model uses to maintain a live checklist
 * (Claude Code's TodoWrite shape): the model writes the whole list each
 * time with exactly one item in_progress, and the rendered checklist in
 * the transcript updates as work progresses.
 *
 * State lives in tool result details, so branching reconstructs the list
 * for that point in history automatically (same pattern as the repo's
 * extensions example).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	todos: Todo[];
	error?: string;
}

const TodoParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			text: Type.String({ description: "Short imperative description of the step" }),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
		}),
		{ description: "The full list, in order. Exactly one item should be in_progress while working." },
	),
});

function renderChecklist(todos: Todo[], theme: Theme, expanded: boolean): string {
	const done = todos.filter((t) => t.status === "completed").length;
	let out = theme.fg("muted", `plan ${done}/${todos.length} done`);
	const visible = expanded ? todos : todos.slice(0, 6);
	for (const todo of visible) {
		if (todo.status === "completed") {
			out += `\n  ${theme.fg("success", "✓")} ${theme.fg("dim", todo.text)}`;
		} else if (todo.status === "in_progress") {
			out += `\n  ${theme.fg("accent", "▸")} ${theme.fg("text", theme.bold(todo.text))}`;
		} else {
			out += `\n  ${theme.fg("dim", "○")} ${theme.fg("muted", todo.text)}`;
		}
	}
	if (!expanded && todos.length > visible.length) {
		out += `\n${theme.fg("dim", `  ... ${todos.length - visible.length} more`)}`;
	}
	return out;
}

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push("");
		lines.push(truncateToWidth(`  ${this.theme.fg("accent", "Todos")}`, width));
		lines.push("");
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No todos yet. Ask the agent to plan one.")}`, width));
		} else {
			for (const line of renderChecklist(this.todos, this.theme, true).split("\n")) {
				lines.push(truncateToWidth(`  ${line}`, width));
			}
		}
		lines.push("");
		lines.push(truncateToWidth(`  ${this.theme.fg("dim", "Press Escape to close")}`, width));
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];

	const reconstructState = (ctx: ExtensionContext): void => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.todos) todos = details.todos;
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Write your visible plan for multi-step work. Pass the FULL list each time in order, with exactly one item in_progress. Update it as you go: mark completed items, move the next to in_progress. Skip it for single-step tasks.",
		promptSnippet:
			"todo: maintain a visible plan checklist for multi-step work (full list per call, one item in_progress)",
		promptGuidelines: [
			"For any task with 2+ real steps, write a todo list first and keep it current - the user watches it to follow progress.",
			"Mark items completed the moment they are done; never batch updates at the end.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params) {
			todos = params.todos.map((t) => ({ text: t.text, status: t.status }));
			const inProgress = todos.find((t) => t.status === "in_progress");
			const summary = inProgress
				? `plan: ${inProgress.text}`
				: `plan: ${todos.filter((t) => t.status === "completed").length}/${todos.length} done`;
			return {
				content: [{ type: "text", text: summary }],
				details: { todos } as TodoDetails,
			};
		},

		renderCall(args, theme, _context) {
			const count = Array.isArray(args.todos) ? args.todos.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${count} step(s)`), 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details?.todos) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			return new Text(renderChecklist(details.todos, theme, expanded), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoListComponent(todos, theme, () => done()));
		},
	});
}
