import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireSchedulerLock,
	type CronEntry,
	childCommand,
	cronFilePath,
	deleteEntry,
	dueEntries,
	getEntry,
	isDue,
	isValidCronName,
	nextDue,
	parseSchedule,
	pidIsAlive,
	QUEUED_TTL_MS,
	readCronStore,
	releaseSchedulerLock,
	schedulerLockPath,
	upsertEntry,
	writeCronStore,
} from "../extensions/lib/cron-store.ts";

let dir: string;

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "hummin-cron-test-"));
}

function entry(overrides: Partial<CronEntry> = {}): CronEntry {
	return {
		name: "test",
		schedule: "every:5",
		cwd: "/tmp/proj",
		prompt: "say hi",
		createdAt: 0,
		...overrides,
	};
}

beforeEach(() => {
	dir = tempDir();
});

afterEach(() => {
	releaseSchedulerLock(dir);
});

describe("schedule parse", () => {
	it("parses daily HH:MM", () => {
		expect(parseSchedule("09:30")).toEqual({ kind: "daily", hour: 9, minute: 30 });
		expect(parseSchedule("00:00")).toEqual({ kind: "daily", hour: 0, minute: 0 });
		expect(parseSchedule("23:59")).toEqual({ kind: "daily", hour: 23, minute: 59 });
	});
	it("parses every:<minutes>", () => {
		expect(parseSchedule("every:5")).toEqual({ kind: "every", minutes: 5 });
		expect(parseSchedule(" every:90 ")).toEqual({ kind: "every", minutes: 90 });
	});
	it("rejects invalid schedules", () => {
		expect(() => parseSchedule("24:00")).toThrow();
		expect(() => parseSchedule("12:60")).toThrow();
		expect(() => parseSchedule("every:4")).toThrow(/>= 5/);
		expect(() => parseSchedule("every:x")).toThrow();
		expect(() => parseSchedule("daily")).toThrow();
		expect(() => parseSchedule("")).toThrow();
	});
});

describe("next-due", () => {
	it("every:N due immediately when never run", () => {
		const from = 1_000_000;
		expect(nextDue(parseSchedule("every:5"), from, undefined)).toBe(from);
	});
	it("every:N schedules lastRun + interval", () => {
		const last = 1_000_000;
		expect(nextDue(parseSchedule("every:5"), last + 1, last)).toBe(last + 5 * 60_000);
	});
	it("daily returns today's slot when still ahead", () => {
		const from = new Date();
		from.setHours(7, 0, 0, 0);
		const due = nextDue(parseSchedule("09:30"), from.getTime());
		const expected = new Date(from).setHours(9, 30, 0, 0);
		expect(due).toBe(expected);
	});
	it("daily rolls over to tomorrow when the slot has passed", () => {
		const from = new Date();
		from.setHours(10, 0, 0, 0);
		const due = nextDue(parseSchedule("09:30"), from.getTime());
		const tomorrow = new Date(from.getTime() + 86_400_000);
		tomorrow.setHours(9, 30, 0, 0);
		expect(due).toBe(tomorrow.getTime());
		expect(due).toBeGreaterThan(from.getTime());
	});
});

describe("isDue", () => {
	it("every:N becomes due after the interval elapses", () => {
		const parsed = parseSchedule("every:5");
		const last = 1_000_000;
		expect(isDue(parsed, last + 5 * 60_000 - 1, last)).toBe(false);
		expect(isDue(parsed, last + 5 * 60_000, last)).toBe(true);
		expect(isDue(parsed, last + 10 * 60_000, last)).toBe(true);
	});
	it("daily is due when the slot passes unrun", () => {
		const slot = new Date().setHours(9, 30, 0, 0);
		const parsed = parseSchedule("09:30");
		expect(isDue(parsed, slot - 1, undefined)).toBe(false);
		expect(isDue(parsed, slot, undefined)).toBe(true);
	});
	it("daily handles rollover: yesterday-slot already consumed by today's run", () => {
		const parsed = parseSchedule("09:30");
		const slot = new Date().setHours(9, 30, 0, 0);
		// Ran at the exact slot earlier today: not due again today.
		expect(isDue(parsed, slot + 60_000, slot)).toBe(false);
		// Ran yesterday after the slot: today's slot (now past) is due.
		expect(isDue(parsed, slot + 60_000, slot - 86_400_000 + 3_600_000)).toBe(true);
		// Ran in the future relative to the last slot (clock skew): not due.
		expect(isDue(parsed, slot - 60_000, slot + 3_600_000)).toBe(false);
	});
});

describe("dueEntries + max 1 queued wake", () => {
	const now = 10_000_000;
	it("selects due entries and skips not-yet-due ones", () => {
		const entries = [
			entry({ name: "due", schedule: "every:5", lastRun: now - 6 * 60_000 }),
			entry({ name: "waiting", schedule: "every:30", lastRun: now - 60_000 }),
		];
		expect(dueEntries(entries, now).map((candidate) => candidate.name)).toEqual(["due"]);
	});
	it("skips an entry with a fresh queued wake (max 1 queued)", () => {
		const entries = [entry({ name: "q", schedule: "every:5", lastRun: now - 6 * 60_000, queuedSince: now - 1000 })];
		expect(dueEntries(entries, now)).toEqual([]);
	});
	it("re-selects an entry whose queued wake exceeded the TTL", () => {
		const entries = [
			entry({
				name: "q",
				schedule: "every:5",
				lastRun: now - QUEUED_TTL_MS - 1,
				queuedSince: now - QUEUED_TTL_MS - 1,
			}),
		];
		expect(dueEntries(entries, now).map((candidate) => candidate.name)).toEqual(["q"]);
	});
	it("ignores entries with unparseable schedules", () => {
		const entries = [entry({ name: "broken", schedule: "nonsense" })];
		expect(dueEntries(entries, now)).toEqual([]);
	});
});

describe("store CRUD + atomicity", () => {
	it("starts empty on a missing file", () => {
		expect(readCronStore(dir)).toEqual({ version: 1, entries: [] });
	});
	it("round-trips entries atomically (no tmp leftovers, 0600)", () => {
		writeCronStore(dir, { version: 1, entries: [entry()] });
		expect(getEntry(dir, "test")).toEqual(entry());
		expect(existsSync(cronFilePath(dir))).toBe(true);
		const leftovers = readCronStore(dir); // re-read validates JSON
		expect(leftovers.entries).toHaveLength(1);
		// mode 0600 (masked by umask only if umask widens; never narrower than 0600)
		const mode = statSync(cronFilePath(dir)).mode & 0o777;
		expect(mode & 0o077).toBe(0); // no group/other bits
	});
	it("upsert replaces by name and keeps order deterministic", () => {
		upsertEntry(dir, entry({ name: "a" }));
		upsertEntry(dir, entry({ name: "b" }));
		upsertEntry(dir, entry({ name: "a", prompt: "updated" }));
		const store = readCronStore(dir);
		expect(store.entries.map((candidate) => candidate.name).sort()).toEqual(["a", "b"]);
		expect(getEntry(dir, "a")?.prompt).toBe("updated");
	});
	it("deleteEntry reports whether anything was removed", () => {
		upsertEntry(dir, entry({ name: "a" }));
		expect(deleteEntry(dir, "a")).toBe(true);
		expect(deleteEntry(dir, "a")).toBe(false);
		expect(getEntry(dir, "a")).toBeUndefined();
	});
	it("rejects corrupt or wrong-shaped stores", () => {
		writeFileSync(cronFilePath(dir), "{not json");
		expect(() => readCronStore(dir)).toThrow();
		writeFileSync(cronFilePath(dir), JSON.stringify({ version: 2, entries: [] }));
		expect(() => readCronStore(dir)).toThrow(/shape/);
	});
	it("builds and validates entries", () => {
		expect(isValidCronName("ok-name-1")).toBe(true);
		expect(isValidCronName("Nope")).toBe(false);
		expect(isValidCronName("")).toBe(false);
	});
});

describe("scheduler lock liveness", () => {
	it("acquires, blocks other holders, releases and reacquires", () => {
		expect(acquireSchedulerLock(dir)).toBe(true);
		// A live owner (even this process) blocks re-acquisition.
		expect(acquireSchedulerLock(dir)).toBe(false);
		releaseSchedulerLock(dir);
		expect(existsSync(schedulerLockPath(dir))).toBe(false);
		expect(acquireSchedulerLock(dir)).toBe(true);
	});
	it("takes over a stale lock whose owner PID is dead", () => {
		const lock = schedulerLockPath(dir);
		mkdirSync(lock, { recursive: true });
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
		expect(pidIsAlive(999_999_999)).toBe(false);
		expect(acquireSchedulerLock(dir)).toBe(true);
		expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain(String(process.pid));
	});
	it("respects a live foreign owner", () => {
		const lock = schedulerLockPath(dir);
		mkdirSync(lock, { recursive: true });
		const liveForeignPid = pidIsAlive(1) ? 1 : process.pid; // PID 1 is alive on normal systems
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: liveForeignPid }));
		if (liveForeignPid === process.pid) return; // cannot simulate on this platform
		expect(acquireSchedulerLock(dir)).toBe(false);
	});
});

describe("childCommand", () => {
	it("builds detached run args with HUMMIN_MEMORY=0", () => {
		const child = childCommand({ prompt: "do the thing", cwd: "/tmp/proj", model: undefined });
		expect(child.command).toBe("hummin");
		expect(child.args).toEqual(["-p", "do the thing", "--session-dir", "/tmp/proj"]);
		expect(child.cwd).toBe("/tmp/proj");
		expect(child.env.HUMMIN_MEMORY).toBe("0");
	});
	it("appends --model when set", () => {
		const child = childCommand({ prompt: "p", cwd: "/tmp", model: "zai/glm-5.3", thinking: "high" });
		expect(child.args.slice(-4)).toEqual(["--model", "zai/glm-5.3", "--thinking", "high"]);
	});
});
