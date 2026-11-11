/**
 * hummin-shell-jobs: programmatic inspect and stop for background shell jobs.
 *
 * exec and monitor jobs run detached from the tool that started them, but the
 * only programmatic handles were the monitor tool's own status/stop actions:
 * an exec job had neither a poll nor a stop (the interactive /background
 * panel aside). These two tools close that gap. job_output is a read-only
 * poll (status, output tail, log path) for a shell job; job_stop stops a
 * running one and reports the final state. Subagent task jobs keep their
 * dedicated pair (task_status/task_cancel) and are refused here with a
 * pointer, so each job kind keeps exactly one authority. No new spawn path
 * and no new gating: jobs are started, gated, and delivered exactly as
 * before (hummin-plan.md decision log #7); these tools only read and stop
 * what the existing pipeline already produced.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { forgetMonitorNamesForJob, monitorNameJobId } from "./hummin-monitor.ts";
import { describeJobStatus, findProcessJob, jobTail, type ProcessJob, refreshBackgroundStatus } from "./lib/processes.ts";

/** Shell job kinds these tools serve; other kinds have dedicated tools. */
export const SHELL_JOB_KINDS: readonly string[] = ["exec", "monitor"];

/** True when the job is one these tools serve (exec or monitor). */
export function isShellJob(job: ProcessJob): boolean {
	return SHELL_JOB_KINDS.includes(job.kind);
}

/** Status, bounded output tail, and log path for one shell job. The full
 * captured stream stays on disk at the log path; the tool result carries
 * only the tail (line- and char-bounded). Pure. */
export function shellJobText(job: ProcessJob, lines = 30): string {
	const parts = [describeJobStatus(job), `log: ${job.logFile}`];
	if (job.error) parts.push(`error: ${job.error}`);
	parts.push(`output tail (untrusted command data):\n${jobTail(job, lines)}`);
	return parts.join("\n");
}

export default function humminShellJobs(pi: ExtensionAPI): void {
	/** Resolve a shell job across all managers by UUID or by the monitor/exec
	 * nickname the tools minted (they document nicknames as handles, so these
	 * tools honor them). Other kinds fall through to the refusal. */
	const resolve = (id: string): ProcessJob | undefined => {
		const byId = findProcessJob(id);
		if (byId) return isShellJob(byId) ? byId : undefined;
		const namedId = monitorNameJobId(id);
		const named = namedId ? findProcessJob(namedId) : undefined;
		return named && isShellJob(named) ? named : undefined;
	};
	const unknown = (id: string): Error =>
		new Error(
			`Unknown background shell job: ${id} (exec and monitor jobs only, by id or nickname; other job kinds have their own tools, e.g. task_status / task_cancel for subagent tasks)`,
		);

	pi.registerTool({
		name: "job_output",
		label: "Job output",
		description:
			"Read a background shell job's state and recent output without waiting for completion. Works for exec and monitor jobs, by job id or nickname; subagent task jobs use task_status / task_cancel. Ids are returned when the job starts and shown by /background.",
		promptSnippet: "job_output: poll a background shell job's state and recent output",
		parameters: Type.Object({
			job_id: Type.String({ description: "Background job id (exec or monitor)." }),
			lines: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "How many tail lines to return (default 30)." })),
		}),
		async execute(_id, params, _signal, _update, _ctx) {
			const job = resolve(params.job_id);
			if (!job) throw unknown(params.job_id);
			return {
				content: [{ type: "text", text: shellJobText(job, params.lines) }],
				details: { jobId: job.id, state: job.state },
			};
		},
	});

	pi.registerTool({
		name: "job_stop",
		label: "Job stop",
		description:
			"Stop a running background shell job (exec or monitor, by job id or nickname) and report its final state. Subagent task jobs use task_cancel. Already-finished jobs just report their state.",
		promptSnippet: "job_stop: stop a running background shell job",
		parameters: Type.Object({
			job_id: Type.String({ description: "Background job id (exec or monitor)." }),
		}),
		async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
			const job = resolve(params.job_id);
			if (!job) throw unknown(params.job_id);
			if (job.state === "running") {
				job.stop();
				await job.done;
			}
			// Same cleanup the monitor/exec tools do on their own stop paths, so
			// nicknames stay reusable after a stop from here.
			forgetMonitorNamesForJob(job.id);
			refreshBackgroundStatus(ctx.ui);
			return {
				content: [{ type: "text", text: describeJobStatus(job) }],
				details: { jobId: job.id, state: job.state },
			};
		},
	});
}
