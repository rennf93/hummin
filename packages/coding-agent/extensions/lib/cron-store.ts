// hummin cron store + scheduling math. Pure Node, no extension API — unit
// testable. Store file: <agentDir>/cron.json (0600, atomic tmp+rename).
// Scheduler lock: broker-style mkdir lock with PID liveness (stale = takeover).
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface CronEntry {
	name: string;
	/** Validated schedule: "HH:MM" (daily, local) or "every:<minutes>" (>= 5). */
	schedule: string;
	cwd: string;
	prompt: string;
	model?: string;
	createdAt: number;
	/** Epoch ms of the last spawn. */
	lastRun?: number;
	/** Exit code of the last spawned run, when observed before shutdown. */
	lastExit?: number | null;
	/** Exact PID of the last spawned child (never kill by name — PIDs only). */
	lastPid?: number;
	/** Set while a wake is in flight; blocks further wakes (max 1 queued). */
	queuedSince?: number;
}

export interface CronStore {
	version: 1;
	entries: CronEntry[];
}

export type ParsedSchedule = { kind: "daily"; hour: number; minute: number } | { kind: "every"; minutes: number };

export const MIN_EVERY_MINUTES = 5;
/** A queued wake older than this is considered abandoned and may re-fire. */
export const QUEUED_TTL_MS = 30 * 60 * 1000;
export const PROMPT_MAX_CHARS = 2000;
const NAME_RE = /^[a-z0-9-]{1,64}$/;

// ============================================================================
// Pure validation + schedule math
// ============================================================================

export function isValidCronName(name: string): boolean {
	return NAME_RE.test(name);
}

/** Parse "HH:MM" (daily, local time) or "every:<minutes>" (>= 5). Throws with an actionable message. */
export function parseSchedule(raw: string): ParsedSchedule {
	const every = /^every:(\d+)$/.exec(raw.trim());
	if (every) {
		const minutes = Number(every[1]);
		if (!Number.isInteger(minutes) || minutes < MIN_EVERY_MINUTES) {
			throw new Error(`Invalid schedule "${raw}": every:<minutes> requires an integer >= ${MIN_EVERY_MINUTES}`);
		}
		return { kind: "every", minutes };
	}
	const daily = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
	if (daily) {
		const hour = Number(daily[1]);
		const minute = Number(daily[2]);
		if (hour > 23 || minute > 59) throw new Error(`Invalid schedule "${raw}": HH:MM out of range`);
		return { kind: "daily", hour, minute };
	}
	throw new Error(`Invalid schedule "${raw}": use "HH:MM" (daily, local) or "every:<minutes>" (>= ${MIN_EVERY_MINUTES})`);
}

function slotOnDay(dayStartMs: number, hour: number, minute: number): number {
	return dayStartMs + (hour * 60 + minute) * 60_000;
}

/** Next occurrence strictly after `fromMs` (local time for daily). */
export function nextDue(parsed: ParsedSchedule, fromMs: number, lastRunMs?: number): number {
	if (parsed.kind === "every") {
		const interval = parsed.minutes * 60_000;
		if (lastRunMs === undefined) return fromMs;
		return Math.max(lastRunMs + interval, fromMs);
	}
	const from = new Date(fromMs);
	const dayStart = new Date(from).setHours(0, 0, 0, 0);
	for (let day = 0; day < 3; day++) {
		const candidate = slotOnDay(dayStart + day * 86_400_000, parsed.hour, parsed.minute);
		if (candidate > fromMs) return candidate;
	}
	// Unreachable (day 2 always qualifies); keeps TypeScript total.
	return fromMs;
}

/** Whether an entry is due at `nowMs` given its last run (daily rollover aware). */
export function isDue(parsed: ParsedSchedule, nowMs: number, lastRunMs?: number): boolean {
	if (parsed.kind === "every") {
		if (lastRunMs === undefined) return true;
		return nowMs - lastRunMs >= parsed.minutes * 60_000;
	}
	// Daily: due once today's slot time has passed and was not already run.
	// (Ran-before checks compare against the most recent slot, today or yesterday.)
	const now = new Date(nowMs);
	const dayStart = new Date(now).setHours(0, 0, 0, 0);
	const todaySlot = slotOnDay(dayStart, parsed.hour, parsed.minute);
	if (lastRunMs === undefined) return nowMs >= todaySlot;
	const lastSlot = nowMs >= todaySlot ? todaySlot : todaySlot - 86_400_000;
	if (lastSlot > nowMs) return false;
	return lastSlot > lastRunMs;
}

/**
 * Entries due for a wake at `nowMs`. An entry with a fresh `queuedSince` is
 * skipped (max 1 queued wake per entry); an entry queued longer than
 * QUEUED_TTL_MS counts as abandoned and is selected again.
 */
export function dueEntries(entries: readonly CronEntry[], nowMs: number): CronEntry[] {
	return entries.filter((entry) => {
		if (entry.queuedSince !== undefined && nowMs - entry.queuedSince < QUEUED_TTL_MS) return false;
		let parsed: ParsedSchedule;
		try {
			parsed = parseSchedule(entry.schedule);
		} catch {
			return false;
		}
		return isDue(parsed, nowMs, entry.lastRun);
	});
}

/** Clear an abandoned queued marker (queued longer than QUEUED_TTL_MS). Returns the entry unchanged otherwise. */
export function clearStaleQueued(entry: CronEntry, nowMs: number): CronEntry {
	if (entry.queuedSince !== undefined && nowMs - entry.queuedSince >= QUEUED_TTL_MS) {
		return { ...entry, queuedSince: undefined };
	}
	return entry;
}

/** argv for a detached run child. Kept pure for tests. */
export function childCommand(entry: Pick<CronEntry, "prompt" | "cwd" | "model">): {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
} {
	const command = process.env.HUMMIN_CRON_BIN || "hummin";
	const args = ["-p", entry.prompt, "--session-dir", entry.cwd];
	if (entry.model) args.push("--model", entry.model);
	return { command, args, cwd: entry.cwd, env: { HUMMIN_MEMORY: "0" } };
}

// ============================================================================
// Store I/O (dir is injected for testability)
// ============================================================================

export function cronFilePath(dir: string): string {
	return join(dir, "cron.json");
}

export function emptyStore(): CronStore {
	return { version: 1, entries: [] };
}

export function readCronStore(dir: string): CronStore {
	let text: string;
	try {
		text = readFileSync(cronFilePath(dir), "utf8");
	} catch (error) {
		if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object") throw new Error("cron.json is not an object");
	const store = parsed as CronStore;
	if (store.version !== 1 || !Array.isArray(store.entries)) throw new Error("cron.json has an unsupported shape");
	return { version: 1, entries: store.entries };
}

/** Atomic write: unique tmp file (wx, 0600) in the same dir, then rename. */
export function writeCronStore(dir: string, store: CronStore): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.cron.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(store, null, "\t")}\n`);
		closeSync(fd);
		renameSync(temp, cronFilePath(dir));
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

/** Read-modify-write helper; the mutator returns the full next entry list. */
export function updateEntries(dir: string, mutate: (entries: CronEntry[]) => CronEntry[]): CronStore {
	const store = readCronStore(dir);
	store.entries = mutate(store.entries);
	writeCronStore(dir, store);
	return store;
}

export function upsertEntry(dir: string, entry: CronEntry): CronStore {
	return updateEntries(dir, (entries) => {
		const next = entries.filter((candidate) => candidate.name !== entry.name);
		next.push(entry);
		return next;
	});
}

export function deleteEntry(dir: string, name: string): boolean {
	const before = readCronStore(dir);
	const after = before.entries.filter((entry) => entry.name !== name);
	if (after.length === before.entries.length) return false;
	writeCronStore(dir, { version: 1, entries: after });
	return true;
}

export function getEntry(dir: string, name: string): CronEntry | undefined {
	return readCronStore(dir).entries.find((entry) => entry.name === name);
}

/** Validate tool params and build a store entry. Throws actionable errors. */
export function buildEntry(params: {
	name: string;
	schedule: string;
	prompt: string;
	cwd?: string;
	model?: string;
}, defaultCwd: string, nowMs: number): CronEntry {
	if (!isValidCronName(params.name)) {
		throw new Error("cron name must match [a-z0-9-] (1-64 chars)");
	}
	parseSchedule(params.schedule); // throws with details
	const prompt = params.prompt;
	if (prompt.length < 1 || prompt.length > PROMPT_MAX_CHARS) {
		throw new Error(`prompt must be 1-${PROMPT_MAX_CHARS} chars`);
	}
	return {
		name: params.name,
		schedule: params.schedule.trim(),
		cwd: params.cwd && params.cwd.trim() ? params.cwd.trim() : defaultCwd,
		prompt,
		model: params.model?.trim() || undefined,
		createdAt: nowMs,
	};
}

// ============================================================================
// Scheduler lock (mkdir lock with PID liveness; stale = takeover)
// ============================================================================

export function schedulerLockPath(dir: string): string {
	return join(dir, "cron.lock");
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

/**
 * Try to become the scheduler for this agent dir. Returns true on success.
 * A live owner always wins; a directory whose owner PID is dead is renamed
 * away (so concurrent waiters cannot delete a fresh acquisition) and retaken.
 */
export function acquireSchedulerLock(dir: string): boolean {
	const lockPath = schedulerLockPath(dir);
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), {
				flag: "wx",
				mode: 0o600,
			});
			return true;
		} catch (error) {
			if (!error || (error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		let owner: { pid?: number } | undefined;
		try {
			owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: number };
		} catch {
			owner = undefined;
		}
		if (owner && typeof owner.pid === "number" && pidIsAlive(owner.pid)) return false;
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
export function releaseSchedulerLock(dir: string): void {
	const lockPath = schedulerLockPath(dir);
	try {
		const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: number };
		if (owner.pid !== process.pid) return;
	} catch {
		// No owner file: still fine to drop a directory we created mkdir-first.
	}
	rmSync(lockPath, { recursive: true, force: true });
}
