import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { searchVault } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
});

// Isolate each test's temp dirs: the module reads both env vars at call time,
// so other test files that override them concurrently must not leak their temp
// dirs into these calls.
beforeEach(() => {
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-vault-search-memory-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-vault-search-vault-"));
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

function seedLesson(record: { cwd: string; lesson: string }): void {
	const file = join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl");
	const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
	writeFileSync(file, `${existing}${JSON.stringify(record)}\n`);
}

function seedEntity(rel: string, content: string): void {
	const path = join(process.env.HUMMIN_MEMORY_VAULT_DIR!, "entities", rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

test("searches all projects' lessons and vault entities, labeled by section", () => {
	seedLesson({
		cwd: PROJ,
		lesson:
			"Problem: dataset quotas silently cap docker volume writes. Approach: raise the quota. Gotcha: zfs applies it lazily.",
	});
	seedLesson({
		cwd: UNRELATED,
		lesson: "Gotcha: docker dataset volume writes stall when quotas are hit on the pool",
	});
	seedEntity(
		"gotcha/docker-quotas.md",
		"# Docker quotas\n\n- dataset quotas stall docker volume writes (from [[lesson-1]], 2026-09-15)\n",
	);
	seedEntity("decision/unrelated.md", "# Unrelated\n\n- something about typography and spacing\n");

	const result = searchVault("docker dataset quotas volume", PROJ);
	expect(result).toContain("Lessons (");
	expect(result).toContain("Vault entities:");
	expect(result).toContain("dataset quotas silently cap");
	// cross-project lesson reachable via the "all" scope floor
	expect(result).toContain("stall when quotas are hit");
	expect(result).toContain("entities/gotcha/docker-quotas.md");
	expect(result).not.toContain("decision/unrelated.md");
});

test("reports no matches when nothing overlaps", () => {
	seedLesson({ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" });
	seedEntity("gotcha/docker-quotas.md", "# Docker quotas\n\n- dataset quotas stall docker volume writes\n");
	const result = searchVault("quantum chromodynamics lattice", PROJ);
	expect(result).toContain("no lessons or entities match");
});

test("works with an empty vault and no lessons", () => {
	// beforeEach already gave this test fresh empty memory + vault dirs.
	const result = searchVault("docker dataset quotas", PROJ);
	expect(result).toContain("no lessons or entities match");
});
