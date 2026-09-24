import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	loadVaultLessons,
	rebuildLessonsFromVault,
	recallLessons,
	unionLessonRecords,
} from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
});

beforeEach(() => {
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-union-memory-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-union-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR!, process.env.HUMMIN_MEMORY_VAULT_DIR!);
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
	if (vaultDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultDirOriginal;
});

const PROJ = "/Users/renzof/Documents/GitHub/ZZZ/hummin";

/** Write a folded lesson the way the fold worker leaves it: frontmatter + body. */
function seedVaultLesson(vaultDir: string, name: string, body: string, frontmatter: Record<string, string> = {}): void {
	const processed = join(vaultDir, "processed");
	mkdirSync(processed, { recursive: true });
	const props = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	writeFileSync(join(processed, name), `---\n${props}\n---\n\n${body}\n`);
}

test("recallLessons returns lessons that live only in the vault processed/ dir", () => {
	seedVaultLesson(
		process.env.HUMMIN_MEMORY_VAULT_DIR!,
		"lesson-2026-09-14T05-25-00-000Z.md",
		"Gotcha: colibri cold-prefill makes slow server starts look like dead connections, so idle the socket instead of raising the timeout",
		{ project: "/Users/renzof/Documents/GitHub/ZZZ/hummin", date: "2026-09-14" },
	);
	// No lessons.jsonl at all, yet the vault lesson is retrievable.
	const lessons = recallLessons(PROJ, "colibri cold-prefill dead connections");
	expect(lessons).toHaveLength(1);
	expect(lessons[0].includes("colibri")).toBe(true);
});

test("same-project slug frontmatter matches the repo basename", () => {
	seedVaultLesson(
		process.env.HUMMIN_MEMORY_VAULT_DIR!,
		"lesson-hummin-cli-release.md",
		"Gotcha: release hummin 1.0.0 with a pinned undici version in the shrinkwrap",
		{ project: "hummin-cli-release", date: "2026-09-17" },
	);
	// Folded lesson stores the project as a slug, not the absolute path.
	const lessons = recallLessons(PROJ, "release hummin undici shrinkwrap version");
	expect(lessons).toHaveLength(1);
	expect(lessons[0].includes("release")).toBe(true);
});

test("cross-project lesson with a non-matching slug stays excluded under project scope", () => {
	seedVaultLesson(
		process.env.HUMMIN_MEMORY_VAULT_DIR!,
		"lesson-roboco-workflows.md",
		"Gotcha: a completely unrelated project about coffee machines and espresso",
		{ project: "roboco-workflows", date: "2026-09-18" },
	);
	const lessons = recallLessons(PROJ, "espresso coffee machine brewing");
	expect(lessons).toHaveLength(0);
});

test("lessons.jsonl and vault dedupe by body so a folded lesson is counted once", () => {
	const body = "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply";
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${JSON.stringify({ timestamp: new Date().toISOString(), cwd: PROJ, project: PROJ, lesson: body })}\n`,
	);
	seedVaultLesson(process.env.HUMMIN_MEMORY_VAULT_DIR!, "lesson-folded.md", body, { date: "2026-09-15" });
	const records = unionLessonRecords(process.env.HUMMIN_MEMORY_VAULT_DIR!);
	expect(records.filter((r) => r.lesson === body)).toHaveLength(1);
});

test("union corpus contains both distillation and vault lessons", () => {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${JSON.stringify({
			timestamp: new Date().toISOString(),
			cwd: PROJ,
			project: PROJ,
			lesson: "Gotcha: jsonl lesson one",
		})}\n`,
	);
	seedVaultLesson(process.env.HUMMIN_MEMORY_VAULT_DIR!, "lesson-folded.md", "Gotcha: vault lesson two", {
		date: "2026-09-15",
	});
	const records = unionLessonRecords(process.env.HUMMIN_MEMORY_VAULT_DIR!);
	expect(records.map((r) => r.lesson)).toHaveLength(2);
	expect(loadVaultLessons(process.env.HUMMIN_MEMORY_VAULT_DIR!).length).toBe(1);
});

test("rebuildLessonsFromVault appends only missing vault lessons (Option A)", () => {
	// Start with a store that only knows one lesson.
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${JSON.stringify({
			timestamp: new Date().toISOString(),
			cwd: PROJ,
			project: PROJ,
			lesson: "Gotcha: jsonl lesson one",
		})}\n`,
	);
	seedVaultLesson(
		process.env.HUMMIN_MEMORY_VAULT_DIR!,
		"lesson-folded-a.md",
		"Gotcha: vault lesson A that is not yet in the store",
		{ date: "2026-09-15" },
	);
	seedVaultLesson(
		process.env.HUMMIN_MEMORY_VAULT_DIR!,
		"lesson-folded-b.md",
		"Gotcha: vault lesson B that is not yet in the store",
		{ date: "2026-09-16" },
	);
	const res = rebuildLessonsFromVault();
	expect(res.added).toBe(2);
	expect(res.total).toBe(3);
	// The original jsonl lesson is still present, order preserved.
	const lines = readFileSync(join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	expect(lines[0].lesson).toBe("Gotcha: jsonl lesson one");
	expect(lines.length).toBe(3);
});
