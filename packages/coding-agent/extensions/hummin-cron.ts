// hummin cron scheduler: cron_create / cron_list / cron_delete tools, a
// single-flight detached-run scheduler, and the /cron panel.
// Env HUMMIN_CRON=0 disables the scheduler; tools stay registered and no-op
// with a notice.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	acquireSchedulerLock,
	type CronEntry,
	childCommand,
	cronFilePath,
	dueEntries,
	deleteEntry,
	getEntry,
	isValidCronName,
	nextDue,
	parseSchedule,
	readCronStore,
	releaseSchedulerLock,
	upsertEntry,
	writeCronStore,
} from "./lib/cron-store.ts";
import { prepareChildDispatch, type ChildDispatchOptions, type ThinkingLevel } from "./lib/child-dispatch-review.ts";

const DISABLED = process.env.HUMMIN_CRON === "0";
const CRON_DISABLED_NOTICE = "cron is disabled (HUMMIN_CRON=0)";

function formatTime(ms: number | undefined): string {
	if (ms === undefined) return "never";
	return new Date(ms).toLocaleString();
}

function formatExit(entry: CronEntry): string {
	if (entry.queuedSince !== undefined) return "running";
	if (entry.lastExit === undefined) return "-";
	return String(entry.lastExit);
}

/** /doctor-style table: name, schedule, cwd, next run, last run, last exit. */
export function formatCronTable(entries: readonly CronEntry[], nowMs: number): string {
	if (entries.length === 0) return "No cron entries. Create one with cron_create.";
	const rows = entries.map((entry) => {
		let next = "-";
		try {
			next = formatTime(nextDue(parseSchedule(entry.schedule), nowMs, entry.lastRun));
		} catch {
			next = `invalid schedule: ${entry.schedule}`;
		}
		return { name: entry.name, schedule: entry.schedule, cwd: entry.cwd, next, lastRun: formatTime(entry.lastRun), lastExit: formatExit(entry) };
	});
	const keys = ["name", "schedule", "cwd", "next", "lastRun", "lastExit"] as const;
	const headers: Record<(typeof keys)[number], string> = { name: "name", schedule: "schedule", cwd: "cwd", next: "next run", lastRun: "last run", lastExit: "exit" };
	const w = Object.fromEntries(keys.map((key) => [key, Math.max(...rows.map((row) => row[key].length), headers[key].length)])) as Record<(typeof keys)[number], number>;
	const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(w[keys[i]])).join("  ");
	return [line(keys.map((key) => headers[key])), ...rows.map((row) => line(keys.map((key) => row[key])))].join("\n");
}

/**
 * One scheduler pass: single-flight via the mkdir lock, spawn due entries
 * detached (exact PID tracking, HUMMIN_MEMORY=0, max 1 queued wake per entry),
 * record lastRun/lastExit. Safe to call from any session; only the lock holder
 * acts, so one scheduler runs at a time across sessions.
 */
export interface SchedulerContext extends Pick<ExtensionContext, "modelRegistry"> {
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
	reviewOptions?: ChildDispatchOptions;
}

export async function runSchedulerPass(dir: string, nowMs: number, context?: SchedulerContext): Promise<string[]> {
	if (!acquireSchedulerLock(dir)) return [];
	try {
		const store = readCronStore(dir);
		const spawned: string[] = [];
		const children = new Map<number, ChildProcess>();
		for (const entry of dueEntries(store.entries, nowMs)) {
			let effective = entry;
			if (context) {
				const review = await prepareChildDispatch({
					kind: "cron",
					prompt: entry.prompt,
					cwd: entry.cwd,
					model: entry.model,
					thinking: entry.thinking as ThinkingLevel | undefined,
					reviewId: entry.reviewId,
					receipt: entry.receipt,
				}, context, context.reviewOptions);
				if (review.action === "block") {
					const held = { ...entry, heldReason: review.reason, reviewId: review.reviewId };
					upsertEntry(dir, held);
					const message = `${entry.name}: held for dispatch review ${review.reviewId ?? "unknown"}: ${review.reason ?? "review required"}`;
					spawned.push(message);
					context.notify?.(message, "warning");
					continue;
				}
				effective = {
					...entry,
					model: `${review.configuration.provider}/${review.configuration.modelId}`,
					thinking: review.configuration.thinking,
					reviewId: review.reviewId,
					receipt: review.receipt,
					heldReason: undefined,
				};
			}
			const { command, args, cwd, env } = childCommand(effective);
			let child;
			try {
				child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" });
			} catch (error) {
				spawned.push(`${entry.name}: spawn failed: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			child.unref();
			const pid = child.pid;
			if (pid === undefined) {
				spawned.push(`${entry.name}: spawn failed (no pid)`);
				continue;
			}
			children.set(pid, child);
			child.on("exit", (code) => {
				children.delete(pid);
				void recordExit(dir, entry.name, pid, code);
			});
			upsertEntry(dir, { ...effective, lastRun: nowMs, lastPid: pid, queuedSince: nowMs, lastExit: undefined });
			spawned.push(`${entry.name}: spawned pid ${pid}`);
		}
		return spawned;
	} finally {
		releaseSchedulerLock(dir);
	}
}

function recordExit(dir: string, name: string, pid: number, code: number | null): void {
	try {
		const entry = getEntry(dir, name);
		if (!entry || entry.lastPid !== pid) return;
		const store = readCronStore(dir);
		writeCronStore(dir, {
			version: 1,
			entries: store.entries.map((candidate) =>
				candidate.name === name && candidate.lastPid === pid ? { ...candidate, lastExit: code, queuedSince: undefined } : candidate,
			),
		});
	} catch {
		// best-effort: never crash the session over a bookkeeping write
	}
}

export default function humminCron(pi: ExtensionAPI): void {
	const dir = join(getAgentDir(), "cron");
	let passInFlight = false;

	const runPass = (ctx?: ExtensionContext) => {
		if (DISABLED || passInFlight) return;
		passInFlight = true;
		const reviewContext = ctx ? { modelRegistry: ctx.modelRegistry, notify: (message: string, level?: "info" | "warning" | "error") => ctx.ui?.notify?.(message, level === "warning" ? "warning" : "info") } : undefined;
		void runSchedulerPass(dir, Date.now(), reviewContext)
			.catch(() => {
				// scheduler failures must never break the session
			})
			.finally(() => {
				passInFlight = false;
			});
	};

	pi.on("session_start", (_event, ctx) => runPass(ctx));
	pi.on("agent_end", (_event, ctx) => runPass(ctx));

	const disabledResult = () => ({
		content: [{ type: "text" as const, text: CRON_DISABLED_NOTICE }],
		details: {},
	});

	pi.registerTool({
		name: "cron_create",
		label: "Cron create",
		description:
			"Create a named scheduled run. Schedule is \"HH:MM\" (daily, local time) or \"every:<minutes>\" (>= 5). At each due time a detached hummin -p run executes the prompt in the entry's cwd and results land in that project's session history.",
		promptSnippet: "cron_create: schedule a recurring detached hummin run",
		parameters: Type.Object({
			name: Type.String({ description: "Unique entry name, [a-z0-9-]" }),
			schedule: Type.String({ description: '"HH:MM" daily local, or "every:<minutes>" with minutes >= 5' }),
			prompt: Type.String({ minLength: 1, maxLength: 2000 }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the run (default: current)" })),
			model: Type.Optional(Type.String({ description: 'Model for the run (default "fast")' })),
			thinking: Type.Optional(Type.String({ description: "Thinking level for the run." })),
			reviewId: Type.Optional(Type.String({ description: "Exact Laya dispatch review ID to accept." })),
			overrideReason: Type.Optional(Type.String({ description: "Reasoned override for the exact Laya dispatch review." })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (DISABLED) return disabledResult();
			if (!isValidCronName(params.name)) throw new Error("cron name must match [a-z0-9-] (1-64 chars)");
			const schedule = parseSchedule(params.schedule); // throws actionable error
			if (getEntry(dir, params.name)) throw new Error(`cron entry "${params.name}" already exists (cron_delete it first)`);
			const cwd = params.cwd?.trim() || ctx.cwd;
			const review = await prepareChildDispatch({
				kind: "cron",
				prompt: params.prompt,
				cwd,
				model: params.model?.trim() || undefined,
				thinking: params.thinking?.trim() as ThinkingLevel | undefined,
				reviewId: params.reviewId,
				overrideReason: params.overrideReason,
			}, { modelRegistry: ctx.modelRegistry }, { agentDir: getAgentDir() });
			if (review.action === "block") throw new Error(review.reason ?? `Dispatch held for review ${review.reviewId ?? "unknown"}`);
			if (review.action === "advisory") ctx.ui?.notify?.(review.reason ?? "Laya dispatch advisory", "warning");
			const entry: CronEntry = {
				name: params.name,
				schedule: params.schedule.trim(),
				cwd,
				prompt: params.prompt,
				model: `${review.configuration.provider}/${review.configuration.modelId}`,
				thinking: review.configuration.thinking,
				reviewId: review.reviewId,
				receipt: review.receipt,
				createdAt: Date.now(),
			};
			upsertEntry(dir, entry);
			let next: string;
			try {
				next = new Date(nextDue(schedule, Date.now(), undefined)).toLocaleString();
			} catch {
				next = "-";
			}
			return {
				content: [{ type: "text", text: `Created cron entry "${entry.name}" (${entry.schedule}); next run ${next}\nStore: ${cronFilePath(dir)}` }],
				details: { name: entry.name, schedule: entry.schedule, cwd: entry.cwd },
			};
		},
	});

	pi.registerTool({
		name: "cron_list",
		label: "Cron list",
		description: "List hummin cron entries: schedule, cwd, next run, last run, last exit.",
		promptSnippet: "cron_list: list scheduled hummin runs",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, _ctx) {
			if (DISABLED) return disabledResult();
			const store = readCronStore(dir);
			return {
				content: [{ type: "text", text: formatCronTable(store.entries, Date.now()) }],
				details: { count: store.entries.length },
			};
		},
	});

	pi.registerTool({
		name: "cron_delete",
		label: "Cron delete",
		description: "Delete a cron entry by exact name.",
		promptSnippet: "cron_delete: remove a scheduled hummin run",
		parameters: Type.Object({
			name: Type.String({ description: "Exact entry name" }),
		}),
		async execute(_id, params, _signal, _update, _ctx) {
			if (DISABLED) return disabledResult();
			if (!deleteEntry(dir, params.name)) throw new Error(`Unknown cron entry: ${params.name}`);
			return { content: [{ type: "text", text: `Deleted cron entry "${params.name}"` }], details: { name: params.name } };
		},
	});

	pi.registerCommand("cron", {
		description: "Show cron entries (next run, last result) and delete entries",
		handler: async (_args, ctx) => {
			if (DISABLED) {
				ctx.ui.notify(CRON_DISABLED_NOTICE, "info");
				return;
			}
			const store = readCronStore(dir);
			if (ctx.mode !== "tui" || store.entries.length === 0) {
				ctx.ui.notify(formatCronTable(store.entries, Date.now()), "info");
				return;
			}
			const selected = await ctx.ui.select("Cron entries", [...store.entries.map((entry) => entry.name), "Close"]);
			if (!selected || selected === "Close") return;
			const entry = store.entries.find((candidate) => candidate.name === selected);
			if (!entry) return;
			let next = "-";
			try {
				next = formatTime(nextDue(parseSchedule(entry.schedule), Date.now(), entry.lastRun));
			} catch {
				// shown as-is below
			}
			const action = await ctx.ui.select(
				`${entry.name} · ${entry.schedule} · next ${next} · last ${formatTime(entry.lastRun)} · exit ${formatExit(entry)}`,
				["Delete entry", "Close"],
			);
			if (action === "Delete entry") {
				deleteEntry(dir, entry.name);
				ctx.ui.notify(`Deleted cron entry "${entry.name}"`, "info");
			}
		},
	});
}
