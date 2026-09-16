/** Bounded child sessions with fleet-aware models and captured output. */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	describeAllProcesses,
	describeJob,
	ProcessManager,
	refreshBackgroundStatus,
} from "./lib/processes.ts";

export function resolveTaskModel(
	requested: string | undefined,
	ctx: Pick<ExtensionContext, "modelRegistry">,
): Model<Api> {
	const models = ctx.modelRegistry.getAvailable();
	const selection = requested?.trim() || "fast";
	let model: Model<Api> | undefined;
	if (selection === "local") {
		model = models.find((entry) => "humminHost" in entry && !("humminOffline" in entry && entry.humminOffline));
	} else if (selection === "fast") {
		model = models.find((entry) => entry.provider === "zai" && entry.id === "glm-5.3-flash");
	} else {
		const slash = selection.indexOf("/");
		if (slash < 1) throw new Error("Use 'fast', 'local', or an explicit provider/model ID");
		model = models.find(
			(entry) => entry.provider === selection.slice(0, slash) && entry.id === selection.slice(slash + 1),
		);
	}
	if (!model) throw new Error(`No configured, available model for ${selection}. Select an explicit provider/model.`);
	if ("humminOffline" in model && model.humminOffline)
		throw new Error("Selected model is offline. Start its server first.");
	return model;
}

export default function humminSubagents(pi: ExtensionAPI): void {
	const manager = new ProcessManager(join(getAgentDir(), "subagents"), "task");
	pi.on("session_shutdown", async () => {
		await manager.close();
	});
	pi.registerCommand("background", {
		description: "List running background tasks and monitors",
		handler: async (_args, ctx) => {
			ctx.ui.notify(describeAllProcesses(), "info");
		},
	});
	pi.registerTool({
		name: "task",
		label: "Task (subagent)",
		description:
			"Run a bounded independent hummin session. Supply a complete brief: children cannot see this conversation. Background completion is delivered automatically. Children share the selected working directory; give concurrent writers separate directories.",
		promptSnippet: "task: delegate a bounded task to an independent session",
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1 }),
			cwd: Type.Optional(Type.String()),
			model: Type.Optional(
				Type.String({
					description: "fast (cloud default), local (first online fleet model), or exact provider/model",
				}),
			),
			timeout_sec: Type.Optional(Type.Number({ minimum: 1, maximum: 86400 })),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const model = resolveTaskModel(params.model, ctx);
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
			const summary = params.prompt.replace(/\s+/g, " ").trim();
			const what = summary.length > 72 ? `${summary.slice(0, 72)}…` : summary || "(empty prompt)";
			const job = manager.start({
				command: "hummin",
				args: ["-p", params.prompt, "--provider", model.provider, "--model", model.id, "--thinking", "off"],
				cwd,
				kind: "task",
				label: `"${what}" · ${model.provider}/${model.id}`,
				timeoutMs: (params.timeout_sec ?? 600) * 1000,
				signal,
				onComplete: params.background
					? (finished) => {
							ctx.ui.notify(`Background ${describeJob(finished)}`, finished.state === "completed" ? "info" : "warning");
							pi.sendMessage(
								{ customType: "hummin-task", content: describeJob(finished), display: true },
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
					: undefined,
			});
			refreshBackgroundStatus(ctx.ui);
			// Make the spawn visible to the user immediately, with what it is and where it logs
			ctx.ui.notify(`Started background ${describeJob(job)}`, "info");
			if (!params.background) await job.done;
			refreshBackgroundStatus(ctx.ui);
			return {
				content: [{ type: "text", text: describeJob(job) }],
				details: { taskId: job.id },
				isError: job.state !== "running" && job.state !== "completed",
			};
		},
	});
	for (const action of ["status", "cancel"] as const) {
		pi.registerTool({
			name: `task_${action}`,
			label: `Task ${action}`,
			description:
				action === "status"
					? "Read a child task's state and output tail."
					: "Cancel a child task owned by this session.",
			parameters: Type.Object({ task_id: Type.String() }),
			async execute(_id, params, _signal, _update, ctx) {
				const job = manager.jobs.get(params.task_id);
				if (!job) throw new Error(`Unknown task: ${params.task_id}`);
				if (action === "cancel") {
					job.stop();
					await job.done;
				}
				refreshBackgroundStatus(ctx.ui);
				return { content: [{ type: "text", text: describeJob(job) }], details: { taskId: job.id } };
			},
		});
	}
}
