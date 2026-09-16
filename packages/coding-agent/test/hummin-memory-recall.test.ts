import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { recallLessons } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
});

// Isolate each test's memory dir: the module reads HUMMIN_MEMORY_DIR at call
// time, so other test files that override it concurrently must not leak their
// temp dir into these calls.
beforeEach(() => {
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-test-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR);
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
});

const PROJ = "/Users/renzof/work/alpha";
const UNRELATED = "/Users/renzof/elsewhere";

function seedLessons(lines: Array<{ cwd: string; lesson: string }>): void {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
	);
}

test("project scope requires keyword overlap and excludes other projects", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
		{ cwd: PROJ, lesson: "Gotcha: restart the hummin container to clear orphaned generations" },
		{ cwd: UNRELATED, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" },
	]);
	// default scope: project only, overlap required
	const lessons = recallLessons(PROJ, "docker compose force-recreate");
	expect(lessons).toEqual(["Gotcha: docker compose needs --force-recreate after mem_limit changes to apply"]);
	// sibling project lesson excluded even with strong overlap
	expect(lessons.some((l) => l.includes("orphaned"))).toBe(false);
});

test("all scope includes cross-project lessons with at least two keyword overlaps", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
		{ cwd: UNRELATED, lesson: "Gotcha: zfs dataset quotas silently cap docker volume writes on this NAS" },
		{ cwd: UNRELATED, lesson: "Gotcha: always warm the cache before benchmarking anything at all" },
	]);
	const lessons = recallLessons(PROJ, "zfs quota docker volume problem", 5, "all");
	// project lesson included (overlap), cross-project zfs lesson passes the floor,
	// the warm-cache lesson does not
	expect(lessons).toHaveLength(2);
	expect(lessons.some((l) => l.includes("zfs"))).toBe(true);
	expect(lessons.some((l) => l.includes("warm"))).toBe(false);
});

test("project lessons rank above cross-project ones, recency breaks ties", () => {
	seedLessons([
		{ cwd: UNRELATED, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" },
		{ cwd: PROJ, lesson: "Gotcha: docker dataset volume writes stall when quotas are hit" },
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
	]);
	const lessons = recallLessons(PROJ, "docker compose quotas", 5, "all");
	// same overlap count: project lessons first, newest project lesson first
	expect(lessons[0]).toBe("Gotcha: docker compose needs --force-recreate after mem_limit changes to apply");
	expect(lessons[1]).toBe("Gotcha: docker dataset volume writes stall when quotas are hit");
	expect(lessons[2]).toBe("Gotcha: docker compose needs --force-recreate after mem_limit changes");
});

test("empty query returns nothing", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
	]);
	expect(recallLessons(PROJ, "the the the")).toEqual([]);
	expect(recallLessons(PROJ, "")).toEqual([]);
});
