import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { recallLessons } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-test-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR);
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
});

const PROJ = "/Users/renzof/work/alpha";
const SIBLING = "/Users/renzof/work/beta";
const UNRELATED = "/Users/renzof/elsewhere";

function seedLessons(lines: Array<{ cwd: string; lesson: string }>): void {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		` ${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
}

test("project lessons rank before sibling lessons, query overlap breaks ties", () => {
	seedLessons([
		// older project lesson with no query overlap
		{ cwd: PROJ, lesson: "Problem: setup scripts drift. Approach: pin versions. Gotcha: none." },
		// sibling lesson, strong overlap with the query
		{ cwd: SIBLING, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
		// newest project lesson, strong overlap
		{ cwd: PROJ, lesson: "Gotcha: restart the colibri container to clear orphaned docker compose generations" },
	]);
	const lessons = recallLessons(PROJ, "docker compose container restart not applying mem_limit");
	expect(lessons).toHaveLength(3);
	// newest matching project lesson first, then the overlapping sibling
	expect(lessons[0]).toContain("orphaned");
	expect(lessons[1]).toContain("--force-recreate");
});

test("cross-project lessons need at least two keyword overlaps", () => {
	seedLessons([
		{ cwd: UNRELATED, lesson: "Gotcha: always warm the cache before benchmarking anything at all" },
		{ cwd: UNRELATED, lesson: "Gotcha: zfs dataset quotas silently cap docker volume writes on this NAS" },
	]);
	const lessons = recallLessons(PROJ, "zfs quota docker volume problem");
	// the zfs/docker lesson clears the cross-project floor, the warm-cache one does not
	expect(lessons).toHaveLength(1);
	expect(lessons[0]).toContain("zfs");
});

test("empty query keeps project lessons by recency and excludes cross-project", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "older project lesson text about deployment" },
		{ cwd: UNRELATED, lesson: "unrelated cross project lesson with deployment words here" },
		{ cwd: PROJ, lesson: "newer project lesson text about deployments" },
	]);
	const lessons = recallLessons(PROJ, "");
	expect(lessons).toEqual([
		"newer project lesson text about deployments",
		"older project lesson text about deployment",
	]);
});
