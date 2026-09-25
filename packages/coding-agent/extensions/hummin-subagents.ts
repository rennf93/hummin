/** Bounded child sessions with fleet-aware models and captured output. */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	adoptRunningJobs,
	allProcessJobs,
	type BackgroundJobRow,
	describeAllProcesses,
	describeJob,
	findProcessJob,
	jobRows,
	type ProcessJob,
	formatDuration,
	migrationChoice,
	outputTail,
	ProcessManager,
	refreshBackgroundStatus,
	stateGlyph,
	backgroundPanelAction,
	dismissProcessJob,
} from "./lib/processes.ts";
import { prepareChildDispatch, resolveChildModel, type ThinkingLevel } from "./lib/child-dispatch-review.ts";

export function resolveTaskModel(requested: string | undefined, ctx: Pick<ExtensionContext, "modelRegistry">): Model<Api> {
	const model = resolveChildModel(requested, ctx);
	if (!model) throw new Error(`No configured, available model for ${requested ?? "fast"}`);
	return model as Model<Api>;
}

// ============================================================================
// Row shaping helpers (pure; unit-tested in test/hummin-subagents-render.test.ts)
// ============================================================================

/** Collapse a prompt to the single-line label shown on task rows. */
export function promptLabel(prompt: string, max = 72): string {
	const summary = prompt.replace(/\s+/g, " ").trim();
	if (!summary) return "(empty prompt)";
	return summary.length > max ? `${summary.slice(0, max)}…` : summary;
}

/** Detail section of a task row: quoted prompt label plus model id. */
export function taskCallDetail(prompt: string, model: string): string {
	return `"${promptLabel(prompt)}" · ${model}`;
}

/**
 * Collapsed one-line row: padded label + detail trimmed to the remaining
 * width, with a suffix that is always kept visible (bash renderer pattern).
 */
export function buildCollapsedRow(width: number, label: string, detail: string, suffix: string): string {
	const prefixWidth = visibleWidth(label) + 1;
	const budget = Math.max(0, width - prefixWidth - visibleWidth(suffix));
	return `${label} ${truncateToWidth(detail, budget, "…")}${suffix}`;
}

/** Structured info carried by hummin-task completion messages. */
export interface TaskCompletionInfo {
	label: string;
	model: string;
	state: string;
	exitCode: number | null;
	durationMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Parse "2m14s"/"45s"/"1h3m5s" durations from describeJob fallback text. */
export function parseDuration(text: string): number | null {
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
	if (!match) return null;
	const [, h, m, s] = match;
	if (h === null && m === null && s === null) return null;
	return Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000;
}

/**
 * Build completion info from the message details object, falling back to
 * parsing the describeJob() text so older messages still render structured
 * info. Text form: `task <id> · <label> · <state> (exit N, <duration>)`.
 */
export function parseTaskCompletion(content: string, details?: unknown): TaskCompletionInfo {
	if (isRecord(details) && typeof details.label === "string" && typeof details.model === "string") {
		return {
			label: details.label,
			model: details.model,
			state: typeof details.state === "string" ? details.state : "completed",
			exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
			durationMs: typeof details.durationMs === "number" ? details.durationMs : null,
		};
	}
	const firstLine = content.split("\n")[0] ?? "";
	const label = /· (.*?) · (?:running|completed|failed|cancelled|timed_out)/.exec(firstLine)?.[1] ?? firstLine;
	const state = /· (running|completed|failed|cancelled|timed_out)/.exec(firstLine)?.[1] ?? "completed";
	const paren = /\((.*)\)$/.exec(firstLine)?.[1] ?? "";
	const exit = /exit (-?\d+|none)/.exec(paren)?.[1];
	const duration = /,\s*(\S+)$/.exec(paren)?.[1];
	return {
		label,
		model: "",
		state,
		exitCode: exit === undefined || exit === "none" ? null : Number(exit),
		durationMs: duration ? parseDuration(duration) : null,
	};
}

/** Structured info parsed from hummin-monitor notification text. */
export interface MonitorNoticeInfo {
	id: string;
	kind: "output" | "lifecycle";
	lines: number | null;
	state: string | null;
	exitCode: number | null;
	/** Short detail for the collapsed row: command match/summary or state. */
	detail: string;
}

/**
 * Parse monitor messages. Text forms: `Monitor <id> output (untrusted
 * command data):\n<lines>` and `Monitor <id>: <state> (exit N) ...`.
 */
export function parseMonitorNotice(content: string): MonitorNoticeInfo {
	const output = /^Monitor (\S+) output \(untrusted command data\):\n?/.exec(content);
	if (output) {
		const rest = content.slice(output[0].length);
		const lines = rest ? rest.split("\n").length : 0;
		return { id: output[1], kind: "output", lines, state: null, exitCode: null, detail: output[1] };
	}
	const lifecycle = /^Monitor (\S+): (running|completed|failed|cancelled|timed_out)(?: \(exit (-?\d+|none)\))?/.exec(
		content,
	);
	if (lifecycle) {
		return {
			id: lifecycle[1],
			kind: "lifecycle",
			lines: null,
			state: lifecycle[2],
			exitCode: lifecycle[3] === undefined || lifecycle[3] === "none" ? null : Number(lifecycle[3]),
			detail: `${lifecycle[2]} (exit ${lifecycle[3] ?? "none"})`,
		};
	}
	return { id: "?", kind: "lifecycle", lines: null, state: null, exitCode: null, detail: content.split("\n")[0] ?? "" };
}

/**
 * Collapsible notice component for custom messages. Custom message renderers
 * are rebuilt with `options.expanded` whenever the transcript toggles output
 * expansion, so they CAN participate in expand/collapse; default is collapsed
 * to a single shaped row and the full report is shown when expanded.
 */
class NoticeComponent implements Component {
	expanded = false;
	private readonly collapsedLine: (width: number) => string;
	private readonly body: Text | undefined;

	constructor(collapsedLine: (width: number) => string, bodyText: string | undefined) {
		this.collapsedLine = collapsedLine;
		this.body = bodyText ? new Text(bodyText, 0, 0) : undefined;
	}

	render(width: number): string[] {
		if (this.expanded && this.body) return this.body.render(width);
		return [this.collapsedLine(width)];
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}

function messageText(message: { content: string | Array<{ type: string; text?: string }> }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
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
		else if (this.kb.matches(data, "app.background.stopOrRemove")) {
			const row = this.rows[this.selected];
			const job = row ? findProcessJob(row.id) : undefined;
			const action = backgroundPanelAction(job);
			if (action === "stop" && job) {
				job.stop();
			} else if (action === "remove" && job) {
				dismissProcessJob(row.id);
			}
			void this.refresh();
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
		lines.push("", `  ${this.theme.fg("dim", "↑/↓ select · Enter actions · ctrl+x stop/remove · Escape close · auto-refreshes")}`);
		return lines;
	}
}

/** Prompt/model metadata per background task, keyed by job id.
 *
 * Lives on `globalThis` (extension modules are re-evaluated per session switch)
 * so an adopted task can rebuild its completion message in the new session.
 */
interface TaskMeta {
	what: string;
	model: string;
}
const TASK_META_KEY = Symbol.for("hummin.subagent.tasks");
const taskMeta = ((globalThis as Record<symbol, unknown>)[TASK_META_KEY] ??= new Map<string, TaskMeta>()) as Map<
	string,
	TaskMeta
>;

export default function humminSubagents(pi: ExtensionAPI): void {
	const manager = new ProcessManager(join(getAgentDir(), "subagents"), "task");

	/** Find a task across ALL managers, including ones adopted from a previous session. */
	const adoptedTask = (id: string): ProcessJob | undefined => {
		const job = findProcessJob(id);
		return job?.kind === "task" ? job : undefined;
	};

	const deliverCompletion = (finished: ProcessJob, meta: TaskMeta): void => {
		const duration = Date.now() - finished.startedAt;
		void pi.sendMessage(
			{
				customType: "hummin-task",
				content: describeJob(finished),
				display: true,
				details: {
					label: `"${meta.what}"`,
					model: meta.model,
					state: finished.state,
					exitCode: finished.exitCode,
					durationMs: duration,
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};
	// Collapsible completion rows for background task reports. Collapsed by
	// default: glyph, label, exit, duration. Expanded shows the full report.
	// extension load. Optional call: headless fakes in tests omit it.
	pi.registerMessageRenderer?.("hummin-task", (message, options, theme) => {
		const text = messageText(message);
		const info = parseTaskCompletion(text, message.details);
		const color = info.state === "completed" ? "success" : info.state === "running" ? "accent" : "error";
		const label = theme.fg("toolTitle", theme.bold("Task completed".padEnd(12)));
		const glyph = theme.fg(color, stateGlyph(info.state as ProcessJob["state"]));
		const detail = info.model ? `${info.label} · ${info.model}` : info.label;
		const suffix = `  ${theme.fg("muted", `· exit ${info.exitCode ?? "none"}${info.durationMs === null ? "" : ` · ${formatDuration(info.durationMs)}`}`)}`;
		const component = new NoticeComponent(
			(width: number) => buildCollapsedRow(width, `${glyph} ${label}`, detail, suffix),
			text,
		);
		component.expanded = options.expanded;
		return component;
	});
	// Collapsible one-line rows for monitor notifications (delivered by the
	// monitor extension, which sends no details object - the renderer parses
	// the known text shape). Collapsed: `Monitor · <id> · N lines` or the
	// lifecycle state; expanded shows the captured output.
	pi.registerMessageRenderer?.("hummin-monitor", (message, options, theme) => {
		const text = messageText(message);
		const info = parseMonitorNotice(text);
		const label = theme.fg("toolTitle", theme.bold("Monitor".padEnd(12)));
		const detail = info.kind === "output" ? `${info.detail} · ${info.lines ?? 0} lines` : info.detail;
		const suffix = info.state ? `  ${theme.fg("muted", `· ${info.state}`)}` : "";
		const component = new NoticeComponent((width: number) => buildCollapsedRow(width, label, detail, suffix), text);
		component.expanded = options.expanded;
		return component;
	});
	pi.on("session_start", async () => {
		// Re-point completion delivery of tasks adopted from an outgoing session
		// (user chose "continue running" on clear) at THIS session.
		for (const job of adoptRunningJobs("task")) {
			const meta = taskMeta.get(job.id);
			if (meta) {
				job.onComplete = (finished: ProcessJob) => {
					taskMeta.delete(finished.id);
					deliverCompletion(finished, meta);
				};
			}
		}
	});

	pi.on("session_shutdown", async (event?) => {
		// Keep tasks alive across a session switch the user chose to migrate;
		// the incoming session's instance re-adopts them on session_start.
		const migrating = event?.reason !== "quit" && migrationChoice() === "migrate";
		if (!migrating) {
			taskMeta.clear();
			await manager.close();
		}
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
			thinking: Type.Optional(Type.String({ description: "Thinking level for the child (off, minimal, low, medium, high, xhigh, max)." })),
			reviewId: Type.Optional(Type.String({ description: "Exact Laya dispatch review ID to accept." })),
			overrideReason: Type.Optional(Type.String({ description: "Reasoned override for the exact Laya dispatch review." })),
			timeout_sec: Type.Optional(Type.Number({ minimum: 1, maximum: 86400 })),
			background: Type.Optional(Type.Boolean()),
		}),
		// Collapsed call row mirrors the shell renderers: padded label, prompt
		// label + model trimmed to the viewport, and a state suffix.
		renderCall(args, toolTheme, context) {
			const model = args?.model?.trim() || "fast";
			const label = toolTheme.fg("toolTitle", toolTheme.bold("Task".padEnd(12)));
			const detail = taskCallDetail(args?.prompt ?? "", model);
			// No "running" suffix here: renderCall components are not rebuilt when
			// the call settles, so a cached suffix would claim "running" forever.
			// Live state lives in /background, the footer segment, and the
			// collapsible completion message.
			const suffix = "";
			const expandedText = new Text(`${label} ${args?.prompt ?? ""}`, 0, 0);
			const expanded = context.expanded;
			return {
				render(width: number): string[] {
					if (expanded) return expandedText.render(width);
					return [buildCollapsedRow(width, label, detail, suffix)];
				},
				invalidate(): void {
					expandedText.invalidate();
				},
			};
		},
		async execute(_id, params, signal, _update, ctx) {
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
			const review = await prepareChildDispatch({
				kind: "task",
				prompt: params.prompt,
				cwd,
				model: params.model?.trim() || undefined,
				thinking: params.thinking?.trim() as ThinkingLevel | undefined,
				reviewId: params.reviewId,
				overrideReason: params.overrideReason,
			}, { modelRegistry: ctx.modelRegistry }, { agentDir: getAgentDir() });
			if (review.action === "block") throw new Error(review.reason ?? `Dispatch held for review ${review.reviewId ?? "unknown"}`);
			if (review.action === "advisory") ctx.ui?.notify?.(review.reason ?? "Laya dispatch advisory", "warning");
			const model = resolveTaskModel(`${review.configuration.provider}/${review.configuration.modelId}`, ctx);
			const thinking = review.configuration.thinking;
			const summary = params.prompt.replace(/\s+/g, " ").trim();
			const what = summary.length > 72 ? `${summary.slice(0, 72)}…` : summary || "(empty prompt)";
			const job = manager.start({
				command: "hummin",
				args: ["-p", params.prompt, "--provider", model.provider, "--model", model.id, "--thinking", thinking],
				cwd,
				kind: "task",
				label: `"${what}" · ${model.provider}/${model.id}`,
				timeoutMs: (params.timeout_sec ?? 600) * 1000,
				// Background tasks outlive the turn: they must NOT inherit the
				// tool-call AbortSignal, or interrupting the agent (escape) would
				// cancel every job spawned during the run. Only foreground tasks
				// are abortable via the turn signal.
				signal: params.background ? undefined : signal,
				onComplete: params.background
					? (finished) => {
							// Delivery dedupe: the followUp message renders the summary, so a
							// notify() of the same describeJob() text here would deliver it twice.
							// Exactly-once holds without a delivery-id: ProcessManager.finish is
							// once-guarded (settled flag) and this callback fires synchronously
							// from it, so sendMessage runs at most once per job.
							const meta = taskMeta.get(finished.id);
							taskMeta.delete(finished.id);
							if (!meta) return;
							deliverCompletion(finished, meta);
						}
					: undefined,
			});
			// Adoption metadata: lets a session that migrates this task rebuild the
			// completion message. Deleted by the completion hook on delivery.
			if (params.background) {
				taskMeta.set(job.id, { what, model: `${model.provider}/${model.id}` });
			}
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
				const job = manager.jobs.get(params.task_id) ?? adoptedTask(params.task_id);
				if (!job) throw new Error(`Unknown task: ${params.task_id}`);				if (action === "cancel") {
					job.stop();
					await job.done;
				}
				refreshBackgroundStatus(ctx.ui);
				return { content: [{ type: "text", text: describeJob(job) }], details: { taskId: job.id } };
			},
		});
	}
}
