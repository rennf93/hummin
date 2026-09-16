import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface ProcessJob {
	id: string;
	/** What kind of background work this is ("task", "monitor", ...). */
	kind: string;
	label: string;
	logFile: string;
	startedAt: number;
	state: "running" | "completed" | "failed" | "cancelled" | "timed_out";
	exitCode: number | null;
	output: string;
	error?: string;
	done: Promise<void>;
	stop: (reason?: "cancelled" | "timed_out") => void;
}

export interface ProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	kind: string;
	label: string;
	timeoutMs: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	onOutput?: (text: string) => void;
	onComplete?: (job: ProcessJob) => void;
}

/** All process managers alive in this extension host, for /background and status counts. */
const managers = new Set<ProcessManager>();

/** Number of currently running background processes across all managers. */
export function runningProcessCount(): number {
	let count = 0;
	for (const manager of managers) {
		for (const job of manager.jobs.values()) {
			if (job.state === "running") count++;
		}
	}
	return count;
}

/** Footer status text, or undefined when nothing is running. */
export function backgroundStatus(): string | undefined {
	const count = runningProcessCount();
	return count > 0 ? `${count} background` : undefined;
}

/** Set or clear the shared "bg" footer status from any extension context. */
export function refreshBackgroundStatus(ui: { setStatus(key: string, text: string | undefined): void } | undefined | null): void {
	if (!ui?.setStatus) return;
	ui.setStatus("bg", backgroundStatus());
}

/** Human-readable description of every job in every manager (the /background panel). */
export function describeAllProcesses(): string {
	const blocks: string[] = [];
	for (const manager of managers) {
		const jobs = [...manager.jobs.values()];
		if (jobs.length === 0) continue;
		blocks.push(jobs.map((job) => describeJob(job)).join("\n\n"));
	}
	return blocks.length > 0 ? blocks.join("\n\n") : "No background processes";
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = seconds % 60;
	if (minutes < 60) return rem > 0 ? `${minutes}m${rem}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/** Owns only directly spawned children. Always drains both pipes, even after
 * the on-disk log reaches its cap. No PID searches or process-group signals.
 */
export class ProcessManager {
	readonly jobs = new Map<string, ProcessJob>();
	readonly kind: string;
	private readonly directory: string;
	private closed = false;
	private readonly active = new Set<string>();

	constructor(directory: string, kind: string) {
		this.directory = directory;
		this.kind = kind;
		managers.add(this);
	}

	start(options: ProcessOptions): ProcessJob {
		if (this.closed) throw new Error("Process manager is closed");
		options.signal?.throwIfAborted();
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid timeout");
		if (this.active.size >= 8) {
			throw new Error("Eight background processes are already running");
		}
		// Bound retained metadata as well as process output.
		for (const id of this.jobs.keys()) {
			if (this.jobs.size < 100) break;
			if (!this.active.has(id)) this.jobs.delete(id);
		}
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const id = randomUUID();
		const logFile = join(this.directory, `${id}.log`);
		const fd = openSync(logFile, "wx", 0o600);
		let bytes = 0;
		let child: ChildProcess | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let drainTimer: NodeJS.Timeout | undefined;
		let settled = false;
		let resolveDone!: () => void;
		const job: ProcessJob = {
			id,
			kind: options.kind,
			label: options.label,
			logFile,
			startedAt: Date.now(),
			state: "running",
			exitCode: null,
			output: "",
			done: new Promise<void>((resolve) => {
				resolveDone = resolve;
			}),
			stop: (reason = "cancelled") => {
				if (settled || job.state !== "running") return;
				job.state = reason;
				if (child && child.exitCode === null && child.signalCode === null) {
					child.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					}, 1500);
				}
			},
		};
		const abort = () => job.stop();
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			job.exitCode = code;
			if (job.state === "running") job.state = code === 0 && !job.error ? "completed" : "failed";
			clearTimeout(timeout);
			clearTimeout(killTimer);
			clearTimeout(drainTimer);
			this.active.delete(id);
			options.signal?.removeEventListener("abort", abort);
			closeSync(fd);
			resolveDone();
			try {
				if (!this.closed) options.onComplete?.(job);
			} catch (error) {
				job.error = `Completion notification failed: ${String(error)}`;
			}
		};
		const output = (text: string) => {
			job.output = (job.output + text).slice(-8000);
			try {
				const buffer = Buffer.from(text);
				const length = Math.min(buffer.length, Math.max(0, 1024 * 1024 - bytes));
				if (length) bytes += writeSync(fd, buffer, 0, length);
				options.onOutput?.(text);
			} catch (error) {
				job.error = String(error);
				job.stop();
			}
		};
		this.jobs.set(id, job);
		this.active.add(id);
		try {
			child = spawn(options.command, options.args, {
				cwd: options.cwd,
				env: { ...process.env, ...options.env, HUMMIN_MEMORY: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.setEncoding("utf8").on("data", output);
			child.stderr?.setEncoding("utf8").on("data", output);
			child.once("error", (error) => {
				job.error = error.message;
			});
			child.once("close", finish);
			child.once("exit", (code) => {
				// Descendants may retain inherited pipes. They are not owned by this
				// manager; don't let them hold session shutdown open indefinitely.
				drainTimer = setTimeout(() => {
					child?.stdout?.destroy();
					child?.stderr?.destroy();
					finish(code);
				}, 1000);
			});
			timeout = setTimeout(() => job.stop("timed_out"), options.timeoutMs);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
		} catch (error) {
			job.error = String(error);
			finish(null);
		}
		return job;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.jobs.values()) job.stop();
		await Promise.all([...this.jobs.values()].map((job) => job.done));
	}
}

export function describeJob(job: ProcessJob): string {
	const elapsed = formatDuration(Date.now() - job.startedAt);
	const state =
		job.state === "running"
			? `running ${elapsed}`
			: `${job.state} (exit ${job.exitCode ?? "none"}, ${elapsed})`;
	const parts = [`${job.kind} ${job.id} · ${job.label} · ${state}`, `log: ${job.logFile}`];
	if (job.error) parts.push(`error: ${job.error}`);
	if (job.output) parts.push(job.output);
	return parts.join("\n");
}
