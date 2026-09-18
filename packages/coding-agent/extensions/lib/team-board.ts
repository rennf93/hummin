// hummin team board: shared task list stored in <dir>/team-board.json inside
// the agents broker directory, so every session on the machine sees the same
// board immediately (shared file, no broker round-trip). Pure Node, no
// extension API — unit testable. All mutations take a mkdir lock with PID
// liveness (same pattern as the cron scheduler lock); stale locks (dead owner
// PID) are renamed away and retaken. Store and lock files are 0600, dirs 0700.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export const TASK_STATUSES = ["queued", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface BoardTask {
	id: string;
	title: string;
	status: TaskStatus;
	/** Session agent name that claimed the task. */
	assignee?: string;
	project: string;
	created: number;
	updated: number;
}

export const TITLE_MAX_CHARS = 200;

// ============================================================================
// Pure task-list operations (unit tested; store I/O wraps these)
// ============================================================================

/** Next id: "t1", "t2", ... = max numeric suffix + 1. */
export function nextTaskId(tasks: readonly BoardTask[]): string {
	let max = 0;
	for (const task of tasks) {
		const match = /^t(\d+)$/.exec(task.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `t${max + 1}`;
}

export function addTask(tasks: readonly BoardTask[], params: { title: string; project: string; assignee?: string }, nowMs: number): BoardTask[] {
	const title = params.title.trim();
	if (!title) throw new Error("Task title must not be empty");
	if (title.length > TITLE_MAX_CHARS) throw new Error(`Task title exceeds ${TITLE_MAX_CHARS} characters`);
	const task: BoardTask = {
		id: nextTaskId(tasks),
		title,
		status: "queued",
		project: params.project,
		created: nowMs,
		updated: nowMs,
	};
	if (params.assignee) {
		task.assignee = params.assignee;
		task.status = "in_progress";
	}
	return [...tasks, task];
}

export function findTask(tasks: readonly BoardTask[], id: string): BoardTask {
	const task = tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown task id: ${id}`);
	return task;
}

/** Claim: set assignee to the claiming session and move to in_progress. Done tasks are closed to claiming. */
export function claimTask(tasks: readonly BoardTask[], id: string, assignee: string, nowMs: number): BoardTask[] {
	findTask(tasks, id); // throws on unknown id
	if (tasks.find((candidate) => candidate.id === id)?.status === "done") {
		throw new Error(`Task ${id} is done and cannot be claimed`);
	}
	return tasks.map((task) => (task.id === id ? { ...task, status: "in_progress" as const, assignee, updated: nowMs } : task));
}

/** Release: clear the assignee and move back to queued. */
export function releaseTask(tasks: readonly BoardTask[], id: string, nowMs: number): BoardTask[] {
	findTask(tasks, id);
	return tasks.map((task) =>
		task.id === id ? { ...task, status: "queued" as const, assignee: undefined, updated: nowMs } : task,
	);
}

/** Done: mark completed (from queued or in_progress). */
export function doneTask(tasks: readonly BoardTask[], id: string, nowMs: number): BoardTask[] {
	findTask(tasks, id);
	return tasks.map((task) => (task.id === id ? { ...task, status: "done" as const, updated: nowMs } : task));
}

export function deleteTask(tasks: readonly BoardTask[], id: string): BoardTask[] {
	findTask(tasks, id);
	return tasks.filter((task) => task.id !== id);
}

/** Project filter for list views; undefined returns everything. */
export function filterByProject(tasks: readonly BoardTask[], project?: string): BoardTask[] {
	return project ? tasks.filter((task) => task.project === project) : [...tasks];
}

/** /doctor-style table grouped by status: queued, in_progress, done. */
export function formatBoard(tasks: readonly BoardTask[], nowMs: number): string {
	if (tasks.length === 0) return "Task board is empty. Add one with task_board {action: \"add\"} or /team.";
	const pad = (value: string, width: number): string => value.padEnd(width);
	const width = (values: readonly string[]): number => Math.max(...values.map((value) => value.length));
	const age = (ms: number): string => {
		const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
		return `${Math.floor(seconds / 86_400)}d`;
	};
	const lines: string[] = [];
	for (const status of TASK_STATUSES) {
		const group = tasks.filter((task) => task.status === status);
		if (group.length === 0) continue;
		lines.push(`${status.replace("_", " ")} (${group.length})`);
		const ids = group.map((task) => task.id);
		const assignees = group.map((task) => task.assignee ?? "-");
		const wId = width(ids);
		const wAssignee = Math.max(width(assignees), "assignee".length);
		for (const [index, task] of group.entries()) {
			lines.push(
				`  ${pad(ids[index], wId)}  ${pad(assignees[index], wAssignee)}  ${age(task.updated).padStart(4)}  ${task.title}`,
			);
		}
	}
	return lines.join("\n");
}

// ============================================================================
// Store I/O (dir is injected for testability)
// ============================================================================

export function boardPath(dir: string): string {
	return join(dir, "team-board.json");
}

export function readBoard(dir: string): BoardTask[] {
	let text: string;
	try {
		text = readFileSync(boardPath(dir), "utf8");
	} catch (error) {
		if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("team-board.json is not a task list");
	return parsed.filter((task): task is BoardTask => {
		return (
			typeof task === "object" &&
			task !== null &&
			typeof (task as BoardTask).id === "string" &&
			typeof (task as BoardTask).title === "string" &&
			TASK_STATUSES.includes((task as BoardTask).status)
		);
	});
}

/** Atomic write: unique tmp file (wx, 0600) in the same dir, then rename. */
export function writeBoard(dir: string, tasks: readonly BoardTask[]): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = `${boardPath(dir)}.${process.pid}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(tasks, null, "\t")}\n`);
		closeSync(fd);
		renameSync(temp, boardPath(dir));
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// already closed by the failing write
		}
		try {
			rmSync(temp, { force: true });
		} catch {
			// best-effort cleanup
		}
		throw error;
	}
}

// ============================================================================
// Board lock (mkdir lock with PID liveness; stale = takeover)
// ============================================================================

export function boardLockPath(dir: string): string {
	return join(dir, "team-board.lock");
}

export function pidIsAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal && signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function readOwnerPid(dir: string): number | undefined {
	try {
		const owner = JSON.parse(readFileSync(join(boardLockPath(dir), "owner.json"), "utf8")) as { pid?: unknown };
		return typeof owner.pid === "number" ? owner.pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Try to acquire the board lock, retrying while a live owner holds it. A
 * directory whose owner PID is dead is renamed away (so concurrent waiters
 * cannot delete a fresh acquisition) and retaken. Honors the abort signal
 * while waiting.
 */
export async function acquireBoardLock(dir: string, signal?: AbortSignal): Promise<boolean> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lockPath = boardLockPath(dir);
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			chmodSync(lockPath, 0o700);
			const fd = openSync(join(lockPath, "owner.json"), "wx", 0o600);
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
			} finally {
				closeSync(fd);
			}
			return true;
		} catch (error) {
			if (!error || (error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		const ownerPid = readOwnerPid(dir);
		if (ownerPid !== undefined && pidIsAlive(ownerPid)) {
			await sleep(LOCK_RETRY_MS, signal); // live owner: wait for release
			continue;
		}
		const stalePath = `${lockPath}.stale-${process.pid}-${attempt}`;
		try {
			renameSync(lockPath, stalePath);
			rmSync(stalePath, { recursive: true, force: true });
		} catch {
			// Another waiter won the stale-lock race; retry.
		}
	}
	return false;
}

/** Release the lock if (and only if) this process owns it. */
export function releaseBoardLock(dir: string): void {
	const lockPath = boardLockPath(dir);
	try {
		const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
		if (owner.pid !== process.pid) return;
	} catch {
		// No owner file: still fine to drop a directory we created mkdir-first.
	}
	rmSync(lockPath, { recursive: true, force: true });
}

/** Read-modify-write under the lock; the mutator returns the full next task list. */
export async function mutateBoard(dir: string, mutate: (tasks: BoardTask[]) => BoardTask[], signal?: AbortSignal): Promise<BoardTask[]> {
	signal?.throwIfAborted();
	if (!(await acquireBoardLock(dir, signal))) {
		throw new Error("Team board is busy (another session holds the lock); retry");
	}
	try {
		const tasks = mutate(readBoard(dir));
		writeBoard(dir, tasks);
		return tasks;
	} finally {
		releaseBoardLock(dir);
	}
}
