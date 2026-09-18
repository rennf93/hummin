/** Bounded child sessions with fleet-aware models and captured output. */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	allProcessJobs,
	type BackgroundJobRow,
	describeAllProcesses,
	describeJob,
	findProcessJob,
	jobRows,
	outputTail,
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

/** Last 30 lines of a job's output, preferring the on-disk log. */
function tailText(job: { logFile: string; output: string }): string {
	let text = job.output;
	try {
		text = readFileSync(job.logFile, "utf8");
	} catch {
		// Log may not exist yet; fall back to captured output.
	}
	return outputTail(text) || "(no output)";
}

/** Live list of background jobs; refreshes on a 2s interval while open. */
class BackgroundPanelComponent {
	private selected = 0;
	private timer: NodeJS.Timeout;
	private rows: BackgroundJobRow[] = [];
	private refreshing = false;
	private disposed = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly done: (row?: BackgroundJobRow) => void;

	constructor(tui: TUI, theme: Theme, kb: KeybindingsManager, done: (row?: BackgroundJobRow) => void) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.done = done;
		this.timer = setInterval(() => void this.refresh(), 2000);
		void this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}

	invalidate(): void {}

	private async refresh(): Promise<void> {
		if (this.refreshing || this.disposed) return;
		this.refreshing = true;
		this.rows = jobRows(allProcessJobs());
		this.refreshing = false;
		if (this.disposed) return;
		if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.kb.matches(data, "tui.select.up"))
			this.selected = (this.selected + this.rows.length - 1) % Math.max(1, this.rows.length);
		else if (this.kb.matches(data, "tui.select.down"))
			this.selected = (this.selected + 1) % Math.max(1, this.rows.length);
		else if (this.kb.matches(data, "tui.select.confirm")) {
			if (this.rows[this.selected]) this.done(this.rows[this.selected]);
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const running = this.rows.filter((row) => row.state === "running").length;
		const title = `Background · ${running} running, ${this.rows.length} total`;
		const lines = [`  ${this.theme.fg("accent", this.theme.bold(title))}`, ""];
		if (this.rows.length === 0) lines.push(`  ${this.theme.fg("dim", "No background processes")}`);
		for (const [index, row] of this.rows.entries()) {
			const color =
				row.state === "running" ? "accent" : row.state === "completed" ? "success" : "error";
			const glyph = this.theme.fg(color, row.glyph);
			const line = `  ${index === this.selected ? this.theme.fg("accent", "▸") : " "}${glyph} ${row.kind.padEnd(8)} ${row.duration}  ${row.label}  ·  ${row.logFile}`;
			lines.push(truncateToWidth(line, width));
		}
		lines.push("", `  ${this.theme.fg("dim", "↑/↓ select · Enter actions · Escape close · auto-refreshes")}`);
		return lines;
	}
}

export default function humminSubagents(pi: ExtensionAPI): void {
	const manager = new ProcessManager(join(getAgentDir(), "subagents"), "task");
	pi.on("session_shutdown", async () => {
		await manager.close();
	});
	pi.registerCommand?.("background", {
		description: "List running background tasks and monitors",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui?.notify?.(describeAllProcesses(), "info");
				return;
			}
			let action: string | undefined = undefined;
			while (action !== "Close") {
				const selected = await ctx.ui?.custom<BackgroundJobRow | undefined>(
					(tui, theme, kb, done) => new BackgroundPanelComponent(tui, theme, kb, done),
				);
				if (!selected) return;
				action = await ctx.ui?.select(`Background ${selected.kind}: ${selected.label}`, [
					"View tail",
					"Cancel",
					"Close",
				]);
				if (!action) return;
				const job = findProcessJob(selected.id);
				if (action === "View tail") {
					ctx.ui?.notify?.(job ? tailText(job) : "Job no longer exists", "info");
				} else if (action === "Cancel") {
					if (!job || job.state !== "running") {
						ctx.ui?.notify?.("Job is not running", "warning");
						continue;
					}
					if (!(await ctx.ui?.confirm?.("Cancel background job", `${selected.kind}: ${selected.label}`))) continue;
					job.stop();
					await job.done;
					refreshBackgroundStatus(ctx.ui);
					ctx.ui?.notify?.(`Cancelled ${selected.kind}: ${selected.label}`, "info");
				}
			}
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
							ctx.ui?.notify?.(`Background ${describeJob(finished)}`, finished.state === "completed" ? "info" : "warning");
							pi.sendMessage(
								{ customType: "hummin-task", content: describeJob(finished), display: true },
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
					: undefined,
			});
			refreshBackgroundStatus(ctx.ui);
			// Make the spawn visible to the user immediately, with what it is and where it logs
			ctx.ui?.notify?.(`Started background ${describeJob(job)}`, "info");
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
