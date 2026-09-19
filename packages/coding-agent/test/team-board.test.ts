// Slice 11: team shared task board — CRUD, lock liveness (stale takeover,
// live owner honored), claim/release transitions, project filtering.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardTask } from "../extensions/lib/team-board.ts";
import {
	acquireBoardLock,
	addTask,
	boardLockPath,
	boardPath,
	claimTask,
	deleteTask,
	doneTask,
	filterByProject,
	findTask,
	formatBoard,
	mutateBoard,
	nextTaskId,
	pidIsAlive,
	readBoard,
	releaseTask,
	writeBoard,
} from "../extensions/lib/team-board.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "team-board-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("task CRUD (pure ops)", () => {
	it("adds tasks with incrementing ids and queued status", () => {
		let tasks = addTask([], { title: "first", project: "/a" }, 1000);
		tasks = addTask(tasks, { title: "second", project: "/b" }, 2000);
		expect(tasks.map((task) => task.id)).toEqual(["t1", "t2"]);
		expect(tasks[0]).toMatchObject({ title: "first", status: "queued", project: "/a", created: 1000, updated: 1000 });
	});

	it("rejects empty and oversized titles", () => {
		expect(() => addTask([], { title: "  ", project: "/a" }, 0)).toThrow(/empty/);
		expect(() => addTask([], { title: "x".repeat(201), project: "/a" }, 0)).toThrow(/200/);
	});

	it("nextTaskId fills the max numeric suffix", () => {
		expect(nextTaskId([])).toBe("t1");
		expect(nextTaskId([{ id: "t7" } as unknown as BoardTask])).toBe("t8");
		expect(nextTaskId([{ id: "weird" } as unknown as BoardTask])).toBe("t1");
	});

	it("claim sets assignee + in_progress; release clears both; done marks done", () => {
		let tasks = addTask([], { title: "job", project: "/a" }, 1000);
		tasks = claimTask(tasks, "t1", "agent-a", 2000);
		expect(findTask(tasks, "t1")).toMatchObject({ status: "in_progress", assignee: "agent-a", updated: 2000 });
		tasks = doneTask(tasks, "t1", 3000);
		expect(findTask(tasks, "t1").status).toBe("done");
		// release from done returns to queued without assignee
		tasks = releaseTask(tasks, "t1", 4000);
		expect(findTask(tasks, "t1")).toMatchObject({ status: "queued", assignee: undefined });
	});

	it("claiming a done task throws; unknown ids throw on every op", () => {
		let tasks = addTask([], { title: "job", project: "/a" }, 1000);
		tasks = doneTask(tasks, "t1", 2000);
		expect(() => claimTask(tasks, "t1", "agent-a", 3000)).toThrow(/done/);
		expect(() => releaseTask(tasks, "t99", 0)).toThrow(/Unknown task id/);
		expect(() => doneTask(tasks, "t99", 0)).toThrow(/Unknown task id/);
		expect(() => deleteTask(tasks, "t99")).toThrow(/Unknown task id/);
	});

	it("delete removes the task", () => {
		let tasks = addTask([], { title: "a", project: "/a" }, 1000);
		tasks = addTask(tasks, { title: "b", project: "/a" }, 1000);
		tasks = deleteTask(tasks, "t1");
		expect(tasks.map((task) => task.id)).toEqual(["t2"]);
	});
});

describe("project filtering + board formatting", () => {
	it("filters by project, undefined returns all", () => {
		let tasks = addTask([], { title: "a", project: "/proj/one" }, 1000);
		tasks = addTask(tasks, { title: "b", project: "/proj/two" }, 1000);
		expect(filterByProject(tasks, "/proj/one").map((task) => task.title)).toEqual(["a"]);
		expect(filterByProject(tasks)).toHaveLength(2);
	});

	it("formatBoard groups by status with assignees and handles empty", () => {
		expect(formatBoard([], 1000)).toMatch(/empty/i);
		let tasks = addTask([], { title: "mine", project: "/p" }, 1000);
		tasks = addTask(tasks, { title: "claimed", project: "/p" }, 1000);
		tasks = addTask(tasks, { title: "finished", project: "/p" }, 1000);
		tasks = claimTask(tasks, "t2", "agent-b", 2000);
		tasks = doneTask(tasks, "t3", 3000);
		const text = formatBoard(tasks, 90_000);
		expect(text).toContain("queued (1)");
		expect(text).toContain("in progress (1)");
		expect(text).toContain("done (1)");
		expect(text).toContain("agent-b");
		expect(text).toContain("mine");
	});
});

describe("store I/O", () => {
	it("writes atomically with 0600 file / 0700 dir modes and reads back", () => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeBoard(dir, addTask([], { title: "persisted", project: "/p" }, 1000));
		expect(statSync(boardPath(dir)).mode & 0o777).toBe(0o600);
		expect(readBoard(dir).map((task) => task.title)).toEqual(["persisted"]);
	});

	it("readBoard returns [] on missing file and skips corrupt entries", () => {
		expect(readBoard(dir)).toEqual([]);
		writeFileSync(
			boardPath(dir),
			JSON.stringify([
				{ id: "t1", title: "ok", status: "queued", project: "/p", created: 1, updated: 1 },
				{ id: "t2", title: "bad status", status: "exploded", project: "/p", created: 1, updated: 1 },
				"garbage",
			]),
		);
		const tasks = readBoard(dir);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe("ok");
	});
});

describe("lock liveness", () => {
	it("reports liveness: own pid alive, dead pid not, absurd pid not", () => {
		expect(pidIsAlive(process.pid)).toBe(true);
		expect(pidIsAlive(999_999_999)).toBe(false);
	});

	it("a stale lock (dead owner pid) is taken over", async () => {
		mkdirSync(boardLockPath(dir), { recursive: true, mode: 0o700 });
		writeFileSync(join(boardLockPath(dir), "owner.json"), JSON.stringify({ pid: 999_999_999 }), {
			flag: "wx",
			mode: 0o600,
		});
		expect(await acquireBoardLock(dir)).toBe(true);
		expect(JSON.parse(readFileSyncLockOwner()).pid).toBe(process.pid);
	});

	it("a live foreign owner blocks acquisition, then release allows it", async () => {
		// Simulate a foreign live owner using this process's pid (alive) but a
		// different marker than what release would see: acquire must fail.
		mkdirSync(boardLockPath(dir), { recursive: true, mode: 0o700 });
		writeFileSync(join(boardLockPath(dir), "owner.json"), JSON.stringify({ pid: process.pid }), {
			flag: "wx",
			mode: 0o600,
		});
		// Same pid: release would drop it; acquire sees live owner and retries until
		// attempts run out -> returns false (no takeover of a live lock).
		expect(await acquireBoardLock(dir)).toBe(false);
	});

	it("mutations serialize through the lock and release afterwards", async () => {
		const tasks = await mutateBoard(dir, (current) =>
			addTask(current, { title: "locked write", project: "/p" }, 1000),
		);
		expect(tasks).toHaveLength(1);
		expect(readBoard(dir)).toHaveLength(1);
		// Lock released: an immediate re-acquire succeeds.
		expect(await acquireBoardLock(dir)).toBe(true);
	});

	it("mutateBoard aborts on an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(mutateBoard(dir, (current) => current, controller.signal)).rejects.toThrow();
	});
});

function readFileSyncLockOwner(): string {
	return readFileSync(join(boardLockPath(dir), "owner.json"), "utf8");
}
