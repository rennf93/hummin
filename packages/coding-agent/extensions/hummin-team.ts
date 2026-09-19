// hummin team: shared task board across sessions, terminals, and projects.
// Board state lives in <agentDir>/agents/team-board.json (the agents broker
// directory, so it is shared by every hummin session on the machine); all
// mutations take a mkdir lock with PID liveness and are atomic, so cross-
// session visibility is immediate — other sessions see changes via /team.
// The task_board tool claims tasks for this session's agent name (same
// resolution as hummin-agents: persisted /agent-name, settings, or pid-name).
import { basename } from "node:path";
import { Type } from "typebox";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { agentsConfig, defaultName, persistedName } from "./hummin-agents.ts";
import { sanitizeName } from "./lib/agents-broker.ts";
import {
	type BoardTask,
	claimTask,
	deleteTask,
	doneTask,
	filterByProject,
	formatBoard,
	mutateBoard,
	readBoard,
	releaseTask,
	addTask,
} from "./lib/team-board.ts";

/** This session's board identity: the same name the agents broker uses. */
export function sessionAgentName(ctx: ExtensionContext): string {
	const cwd = process.cwd();
	const persisted = persistedName(ctx);
	if (persisted) return sanitizeName(persisted);
	return sanitizeName(agentsConfig(cwd).name ?? defaultName(cwd));
}

function projectArg(project?: string): string {
	const trimmed = project?.trim();
	return trimmed ? trimmed : process.cwd();
}

function taskResult(tasks: readonly BoardTask[], message: string, project?: string): {
	content: [{ type: "text"; text: string }];
	details: { count: number };
} {
	const visible = filterByProject(tasks, project);
	return {
		content: [{ type: "text", text: `${message}\n\n${formatBoard(visible, Date.now())}` }],
		details: { count: visible.length },
	};
}

export default function humminTeam(pi: ExtensionAPI): void {
	const dir = `${getAgentDir()}/agents`;

	pi.registerTool({
		name: "task_board",
		label: "Task board",
		description:
			"Shared team task board, visible to all hummin sessions immediately. list shows tasks grouped by status; add queues a task; claim assigns it to this session (queued -> in_progress); release puts it back to queued; done marks it completed; delete removes it.",
		promptSnippet: "task_board: shared team task board (list/add/claim/release/done/delete)",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("claim"),
				Type.Literal("release"),
				Type.Literal("done"),
				Type.Literal("delete"),
			]),
			id: Type.Optional(Type.String({ description: "Task id (required for claim/release/done/delete)" })),
			title: Type.Optional(Type.String({ description: "Task title (required for add)" })),
			project: Type.Optional(
				Type.String({ description: "Project path the task belongs to (add: defaults to cwd; list: filter)" }),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			switch (params.action) {
				case "list": {
					const tasks = filterByProject(readBoard(dir), params.project);
					return taskResult(tasks, `Task board (${tasks.length} task(s))`);
				}
				case "add": {
					const title = params.title?.trim();
					if (!title) throw new Error("add requires a title");
					const project = projectArg(params.project);
					const tasks = await mutateBoard(dir, (current) => addTask(current, { title, project }), signal);
					return taskResult(tasks, `Added task "${title}" (${basename(project)})`, params.project);
				}
				case "claim": {
					if (!params.id) throw new Error("claim requires a task id");
					const assignee = sessionAgentName(ctx);
					const tasks = await mutateBoard(dir, (current) => claimTask(current, params.id as string, assignee, Date.now()), signal);
					return taskResult(tasks, `Task ${params.id} claimed by ${assignee}`, params.project);
				}
				case "release": {
					if (!params.id) throw new Error("release requires a task id");
					const tasks = await mutateBoard(dir, (current) => releaseTask(current, params.id as string, Date.now()), signal);
					return taskResult(tasks, `Task ${params.id} released`, params.project);
				}
				case "done": {
					if (!params.id) throw new Error("done requires a task id");
					const tasks = await mutateBoard(dir, (current) => doneTask(current, params.id as string, Date.now()), signal);
					return taskResult(tasks, `Task ${params.id} done`, params.project);
				}
				case "delete": {
					if (!params.id) throw new Error("delete requires a task id");
					const tasks = await mutateBoard(dir, (current) => deleteTask(current, params.id as string), signal);
					return taskResult(tasks, `Task ${params.id} deleted`, params.project);
				}
			}
		},
	});

	pi.registerCommand("team", {
		description: "Show the shared team task board and manage tasks",
		handler: async (_args, ctx) => {
			for (;;) {
				const board = readBoard(dir);
				const table = formatBoard(board, Date.now());
				if (ctx.mode !== "tui") {
					ctx.ui.notify(table, "info");
					return;
				}
				const options = [...board.map((task) => `${task.id} [${task.status}] ${task.title}`), "Add task", "Close"];
				const selected = await ctx.ui.select("Team task board", options);
				if (!selected || selected === "Close") return;
				if (selected === "Add task") {
					const title = await ctx.ui.input("Task title");
					if (!title?.trim()) continue;
					await mutateBoard(dir, (current) => addTask(current, { title: title.trim(), project: process.cwd() }), undefined);
					ctx.ui.notify("Task added", "info");
					continue;
				}
				const id = selected.slice(0, selected.indexOf(" "));
				const task = board.find((candidate) => candidate.id === id);
				if (!task) continue;
				const actions =
					task.status === "queued"
						? ["Claim", "Done", "Delete", "Back"]
						: task.status === "in_progress"
							? ["Release", "Done", "Delete", "Back"]
							: ["Delete", "Back"];
				const action = await ctx.ui.select(
					`${task.id} · ${task.title}${task.assignee ? ` · ${task.assignee}` : ""} · ${basename(task.project)}`,
					actions,
				);
				if (!action || action === "Back") continue;
				try {
					if (action === "Claim") {
						await mutateBoard(dir, (current) => claimTask(current, id, sessionAgentName(ctx), Date.now()), undefined);
						ctx.ui.notify(`Task ${id} claimed by ${sessionAgentName(ctx)}`, "info");
					} else if (action === "Release") {
						await mutateBoard(dir, (current) => releaseTask(current, id, Date.now()), undefined);
						ctx.ui.notify(`Task ${id} released`, "info");
					} else if (action === "Done") {
						await mutateBoard(dir, (current) => doneTask(current, id, Date.now()), undefined);
						ctx.ui.notify(`Task ${id} done`, "info");
					} else if (action === "Delete") {
						await mutateBoard(dir, (current) => deleteTask(current, id), undefined);
						ctx.ui.notify(`Task ${id} deleted`, "info");
					}
				} catch (error) {
					ctx.ui.notify(`Task ${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		},
	});
}
