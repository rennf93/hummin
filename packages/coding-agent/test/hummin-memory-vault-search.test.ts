import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { searchVault } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
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

test("returns matching lessons and entities, labeled by section", () => {
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
	expect(result).toContain("entities/gotcha/docker-quotas.md");
	expect(result).not.toContain("decision/unrelated.md");
});

test("reports no entity matches when only lessons overlap", () => {
	// Same-project lessons always qualify (no floor), so the lessons section is
	// present; the vault entities section is absent because nothing matched.
	const result = searchVault("quantum chromodynamics lattice", PROJ);
	expect(result).toContain("Lessons (");
	expect(result).not.toContain("Vault entities:");
});

test("works with an empty vault and no lessons", () => {
	const emptyVault = mkdtempSync(join(tmpdir(), "hummin-vault-search-empty-"));
	createdDirs.push(emptyVault);
	const emptyMemory = mkdtempSync(join(tmpdir(), "hummin-vault-search-nomem-"));
	createdDirs.push(emptyMemory);
	const memOriginal = process.env.HUMMIN_MEMORY_DIR;
	process.env.HUMMIN_MEMORY_VAULT_DIR = emptyVault;
	process.env.HUMMIN_MEMORY_DIR = emptyMemory;
	try {
		const result = searchVault("docker dataset quotas", PROJ);
		expect(result).toContain("no lessons or entities match");
	} finally {
		process.env.HUMMIN_MEMORY_DIR = memOriginal;
		process.env.HUMMIN_MEMORY_VAULT_DIR = createdDirs[1];
	}
});
