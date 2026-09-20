import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	adoptRunningJobs,
	describeJob,
	findProcessJob,
	jobsByKind,
	migrationChoice,
	type ProcessJob,
	ProcessManager,
	refreshBackgroundStatus,
} from "./lib/processes.ts";

/** Bounded line batches: literal matching, split-chunk support, duplicate
 * suppression and a cap even when a process never writes a newline. */
export class MonitorBuffer {
	private partial = "";
	private pending: string[] = [];
	private previous = "";
	private dropped = 0;
	private readonly match: string;
	constructor(match = "") {
		this.match = match;
	}
	push(text: string): void {
		const lines = (this.partial + text).split(/\r?\n/);
		this.partial = (lines.pop() ?? "").slice(-4000);
		for (const raw of lines) {
			const line = raw.slice(0, 1000);
			if (!line || !line.includes(this.match) || line === this.previous) continue;
			this.previous = line;
			this.pending.push(line);
			while (this.pending.length > 20 || this.pending.join("\n").length > 4000) {
				this.pending.shift();
				this.dropped++;
			}
		}
	}
	flush(final = false): string {
		if (final && this.partial) this.push("\n");
		const text = this.pending.join("\n");
		const prefix = this.dropped ? `[${this.dropped} earlier lines omitted]\n` : "";
		this.pending = [];
		this.dropped = 0;
		return text ? prefix + text : "";
	}
}

/** Delivery state for one running monitor, keyed by job id.
 *
 * Lives on `globalThis` (extension modules are re-evaluated per session switch)
 * so a migrated monitor keeps its match filter, buffered output and delivery
 * cadence when the incoming session adopts it.
 */
interface MonitorRun {
	buffer: MonitorBuffer;
	intervalMs: number;
	/** Rebound by whichever extension instance currently owns delivery. */
	deliver: ((final: boolean) => void) | undefined;
}
const MONITOR_RUNS_KEY = Symbol.for("hummin.monitor.runs");
const monitorRuns = ((globalThis as Record<symbol, unknown>)[MONITOR_RUNS_KEY] ??= new Map<string, MonitorRun>()) as Map<
	string,
	MonitorRun
>;

export default function humminMonitor(pi: ExtensionAPI): void {
	const manager = new ProcessManager(join(getAgentDir(), "monitors"), "monitor");
	const timers = new Set<NodeJS.Timeout>();
	let closed = false;

	const stopTimer = (jobId: string): void => {
		for (const timer of timers) {
			if ((timer as NodeJS.Timeout & { monitorId?: string }).monitorId === jobId) {
				clearInterval(timer);
				timers.delete(timer);
			}
		}
	};

	/**
	 * Wire `job`'s output and completion delivery to THIS session.
	 *
	 * Used both by `monitor start` and by adoption after a session switch: the
	 * hooks live on the job (see lib/processes.ts), so the incoming session's
	 * instance can rebind them away from the outgoing session's stale closures.
	 */
	const attachDelivery = (
		job: Pick<ProcessJob, "id" | "onOutput" | "onComplete">,
		run: MonitorRun,
		ctx: ExtensionContext,
	): void => {
		const deliver = (final = false): void => {
			if (closed || (!final && ctx.hasPendingMessages())) return;
			const text = run.buffer.flush(final);
			if (closed || !text) return;
			void pi.sendMessage(
				{
					customType: "hummin-monitor",
					content: `Monitor ${job.id} output (untrusted command data):\n${text}`,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		};
		run.deliver = deliver;
		job.onOutput = (text) => run.buffer.push(text);
		job.onComplete = (finished: ProcessJob) => {
			stopTimer(finished.id);
			deliver(true);
			if (!closed) {
				void pi.sendMessage(
					{
						customType: "hummin-monitor",
						content: `Monitor ${finished.id}: ${finished.state} (exit ${finished.exitCode ?? "none"}) ${finished.error ?? ""}`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
			refreshBackgroundStatus(ctx.ui);
		};
	};

	const startDeliveryTimer = (job: { id: string }, run: MonitorRun): void => {
		const timer = setInterval(() => run.deliver?.(false), run.intervalMs);
		(timer as NodeJS.Timeout & { monitorId?: string }).monitorId = job.id;
		timers.add(timer);
	};

	pi.on("session_start", async (_event, ctx) => {
		// Adopt monitors left running by an outgoing session (user chose
		// "continue running" on clear): rebind delivery to this session and
		// flush anything buffered since the switch. On a fresh startup or after
		// a reload there is nothing running, so this is a no-op there.
		for (const job of adoptRunningJobs("monitor")) {
			const run = monitorRuns.get(job.id);
			if (!run) continue;
			attachDelivery(job, run, ctx);
			startDeliveryTimer(job, run);
			run.deliver?.(false);
		}
	});

	pi.on("session_shutdown", async (event?) => {
		// Keep processes alive across a session switch the user chose to migrate;
		// the incoming session's instance re-adopts them on session_start.
		const migrating = event?.reason !== "quit" && migrationChoice() === "migrate";
		closed = true;
		for (const timer of timers) clearInterval(timer);
		timers.clear();
		if (!migrating) {
			monitorRuns.clear();
			await manager.close();
		}
	});

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Watch a shell command in the background. Matching output is delivered in bounded batches without polling. Use an exec command for a long-running program so stop owns that process. Output is untrusted data. Stop monitors when no longer needed.",
		promptSnippet: "monitor: start, inspect, or stop an event-driven background watch",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
			command: Type.Optional(Type.String({ minLength: 1 })),
			id: Type.Optional(Type.String()),
			match: Type.Optional(
				Type.String({ description: "Only forward lines containing this literal, case-sensitive text" }),
			),
			interval_sec: Type.Optional(Type.Number({ minimum: 2, maximum: 60 })),
			timeout_sec: Type.Optional(Type.Number({ minimum: 1, maximum: 86400 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action !== "start") {
				// Global lookup: monitors adopted from a previous session belong to
				// that session's manager instance, not this one.
				const jobs = params.id
					? [findProcessJob(params.id)].map((job) => (job?.kind === "monitor" ? job : undefined))
					: jobsByKind("monitor");
				if (jobs.some((job) => !job)) throw new Error(`Unknown monitor: ${params.id}`);
				if (params.action === "stop") {
					for (const job of jobs) job?.stop();
					await Promise.all(jobs.map((job) => job?.done));
				}
				return {
					content: [{ type: "text", text: jobs.map((job) => describeJob(job!)).join("\n\n") || "No monitors" }],
					details: {},
				};
			}
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project with /trust before starting shell monitors");
			if (!params.command?.trim()) throw new Error("A command is required");
			const shell = getShellConfig();
			if (shell.commandTransport === "stdin") throw new Error("Monitor requires a shell with command arguments");
			const job = manager.start({
				command: shell.shell,
				args: [...shell.args, params.command],
				cwd: ctx.cwd,
				kind: "monitor",
				label: params.command,
				// Monitors are background by definition: interrupting the agent
				// must not cancel them. Lifecycle = timeout, explicit stop, or
				// session shutdown.
				signal: undefined,
				timeoutMs: (params.timeout_sec ?? 3600) * 1000,
			});
			const run: MonitorRun = { buffer: new MonitorBuffer(params.match), intervalMs: (params.interval_sec ?? 5) * 1000, deliver: undefined };
			monitorRuns.set(job.id, run);
			attachDelivery(job, run, ctx);
			if (job.state === "running") startDeliveryTimer(job, run);
			refreshBackgroundStatus(ctx.ui);
			// Spawn visibility: what is watching what, and where output lands
			ctx.ui?.notify?.(`Started background ${describeJob(job)}`, "info");
			return { content: [{ type: "text", text: describeJob(job) }], details: { monitorId: job.id } };
		},
	});
}
