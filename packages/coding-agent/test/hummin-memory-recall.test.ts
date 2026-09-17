import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { recallLessons } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
});

// Isolate each test's memory and vault dirs: the module reads both env vars
// at call time, so other test files that override them concurrently must not
// leak their temp dirs into these calls.
beforeEach(() => {
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-test-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR, process.env.HUMMIN_MEMORY_VAULT_DIR);
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
	if (vaultDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultDirOriginal;
});

const PROJ = "/Users/renzof/work/alpha";
const UNRELATED = "/Users/renzof/elsewhere";

function seedLessons(lines: Array<{ cwd: string; lesson: string }>): void {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
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

test("three-character terms match (zfs, api, git)", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: zfs dataset quotas silently cap docker volume writes on this NAS" },
		{ cwd: PROJ, lesson: "Gotcha: the api gateway strips the git ref from webhook payloads" },
		{ cwd: PROJ, lesson: "Gotcha: restart the hummin container to clear orphaned generations" },
	]);
	expect(recallLessons(PROJ, "zfs quota")).toHaveLength(1);
	expect(recallLessons(PROJ, "api gateway")).toHaveLength(1);
	// single 3-char term alone is enough for project scope
	expect(recallLessons(PROJ, "git")).toHaveLength(1);
});

test("exact phrase bonus ranks contiguous matches above scattered overlaps", () => {
	seedLessons([
		// 3 scattered query terms but no contiguous phrase
		{ cwd: PROJ, lesson: "Gotcha: docker volumes need recreate after quota changes, restart compose too" },
		// 2 overlapping terms plus the exact phrase "docker volume"
		{ cwd: PROJ, lesson: "Gotcha: a docker volume can silently hit the pool quota" },
	]);
	const lessons = recallLessons(PROJ, "docker volume quotas", 5);
	expect(lessons[0]).toBe("Gotcha: a docker volume can silently hit the pool quota");
});

test("recency bias ranks newer lessons above older ones on equal overlap", () => {
	const now = Date.now();
	const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" },
		{ cwd: PROJ, lesson: "Gotcha: stale docker compose state needs --force-recreate after mem_limit changes" },
	]);
	// rewrite with timestamps: first lesson is old, second is fresh
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${[
			{
				timestamp: iso(300 * 86_400_000),
				cwd: PROJ,
				lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes",
			},
			{
				timestamp: iso(0),
				cwd: PROJ,
				lesson: "Gotcha: stale docker compose state needs --force-recreate after mem_limit changes",
			},
		]
			.map((l) => JSON.stringify(l))
			.join("\n")}\n`,
	);
	// same overlap, no contiguous phrase: the fresh lesson wins
	const lessons = recallLessons(PROJ, "compose recreate mem_limit", 5);
	expect(lessons[0]).toBe("Gotcha: stale docker compose state needs --force-recreate after mem_limit changes");
	// and the bias cannot drown relevance: the zero-overlap lesson never appears
	expect(lessons).toHaveLength(2);
});
