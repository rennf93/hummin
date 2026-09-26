import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";
import { lessonsForChildBrief } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryOriginal: string | undefined;
let vaultOriginal: string | undefined;
let pathOriginal: string | undefined;

beforeEach(() => {
	memoryOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
	pathOriginal = process.env.PATH;
	// Each test gets isolated temp dirs and enables memory via HUMMIN_MEMORY=1
	// (the module's cachedSettings is undefined under test, so the env var is
	// the enablement path the child-brief gate actually reads).
	process.env.HUMMIN_MEMORY = "1";
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-child-brief-memory-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-child-brief-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR, process.env.HUMMIN_MEMORY_VAULT_DIR);
});

afterAll(() => {
	delete process.env.HUMMIN_MEMORY;
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryOriginal;
	if (vaultOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultOriginal;
	if (pathOriginal === undefined) delete process.env.PATH;
	else process.env.PATH = pathOriginal;
});

// lessonsForChildBrief recalls for process.cwd(), so seed lessons with this cwd.
const CWD = process.cwd();

function seedLesson(lesson: string, cwd: string = CWD): void {
	const file = join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl");
	const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
	writeFileSync(file, `${existing}${JSON.stringify({ cwd, lesson })}\n`);
}

test("returns null when memory is disabled, the query is empty, or nothing matches", async () => {
	seedLesson("Gotcha: docker compose needs --force-recreate after mem_limit changes");
	process.env.HUMMIN_MEMORY = "0";
	expect(await lessonsForChildBrief("docker compose force-recreate")).toBeNull();
	process.env.HUMMIN_MEMORY = "1";
	expect(await lessonsForChildBrief("")).toBeNull();
	expect(await lessonsForChildBrief("quantum chromodynamics lattice")).toBeNull();
});

test("returns at most two project lessons, ranked and capped", async () => {
	seedLesson("Gotcha: docker compose needs --force-recreate after mem_limit changes");
	seedLesson("Gotcha: docker compose needs --force-recreate after mem_limit changes to apply");
	seedLesson("Gotcha: docker compose state lives in orphaned volumes");
	// Sibling project: must not leak into the child briefing (project scope).
	seedLesson("Gotcha: docker compose needs --force-recreate everywhere", "/some/other/project");
	const brief = await lessonsForChildBrief("docker compose force-recreate");
	expect(brief).not.toBeNull();
	expect(brief).toMatch(/^Relevant lessons from prior work:/);
	// Header plus exactly two "- " lesson lines: top 2 only.
	const lines = brief!.split("\n");
	expect(lines).toHaveLength(3);
	expect(lines[1]).toMatch(/^- /);
	expect(lines[2]).toMatch(/^- /);
	expect(brief).toContain("after mem_limit changes");
	expect(brief).not.toContain("/some/other/project");
	expect(brief).not.toContain("everywhere");
});

test("truncates the first lesson rather than returning nothing on a tight cap", async () => {
	seedLesson(`Problem: zfs quota silently caps writes ${"x".repeat(300)}`);
	const brief = await lessonsForChildBrief("zfs quota", 80);
	expect(brief).not.toBeNull();
	expect(brief).toMatch(/^Relevant lessons from prior work:/);
	expect(brief).toContain("...");
	expect(brief!.length).toBeLessThanOrEqual(80);
});

test("makes no model call and stamps no lastInjectedAt", async () => {
	// A hummin mock whose marker file would prove a model call happened.
	const bin = mkdtempSync(join(tmpdir(), "hummin-child-brief-bin-"));
	createdDirs.push(bin);
	const argsFile = join(bin, "args");
	writeFileSync(join(bin, "hummin"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argsFile}\necho none\n`);
	chmodSync(join(bin, "hummin"), 0o755);
	process.env.PATH = `${bin}:${pathOriginal ?? ""}`;
	seedLesson("Gotcha: docker compose needs --force-recreate after mem_limit changes");
	const brief = await lessonsForChildBrief("docker compose force-recreate");
	expect(brief).not.toBeNull();
	// Advisory briefing: no expansion call, no usage stamp in the store.
	expect(existsSync(argsFile)).toBe(false);
	const line = readFileSync(join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"), "utf8").trim();
	expect(JSON.parse(line).lastInjectedAt).toBeUndefined();
});
