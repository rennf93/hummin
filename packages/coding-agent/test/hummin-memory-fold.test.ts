import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";
import { MEMORY_WORKER_SOURCE } from "../extensions/lib/memory-workers.ts";

// Fresh temp dirs per test: the worker source and job files are written into
// the memory dir; fold output goes into the vault dir. Never the real store.
const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;
let pathOriginal: string | undefined;
let workDir: string;

beforeEach(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
	pathOriginal = process.env.PATH;
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-fold-memory-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-fold-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR, process.env.HUMMIN_MEMORY_VAULT_DIR);
	workDir = process.env.HUMMIN_MEMORY_DIR;
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
	if (vaultDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultDirOriginal;
	if (pathOriginal !== undefined) process.env.PATH = pathOriginal;
});

/** A fake `hummin` on PATH so the worker's model call never leaves the machine. */
function stubHummin(output: string): void {
	const bin = join(workDir, "bin");
	mkdirSync(bin, { recursive: true });
	const script = join(bin, "hummin");
	writeFileSync(script, `#!/bin/sh\necho "${output}"\n`);
	chmodSync(script, 0o755);
	process.env.PATH = `${bin}:${pathOriginal ?? ""}`;
}

function writeWorkerAndJob(job: Record<string, unknown>): string {
	const workerPath = join(workDir, "memory-worker.mjs");
	writeFileSync(workerPath, MEMORY_WORKER_SOURCE);
	const jobPath = join(workDir, ".fold-job.json");
	writeFileSync(jobPath, JSON.stringify(job));
	return jobPath;
}

function runWorker(mode: "fold" | "prune", jobPath: string): number {
	const res = spawnSync(process.execPath, [join(workDir, "memory-worker.mjs"), mode, jobPath], {
		encoding: "utf8",
		env: { ...process.env, HUMMIN_MEMORY: "0" },
		timeout: 30_000,
	});
	return res.status ?? -1;
}

test("fold mode runs the stubbed model call, appends fold.log, releases the lock, removes the job", () => {
	stubHummin("fake fold output");
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	mkdirSync(join(vault, "inbox"), { recursive: true });
	writeFileSync(join(vault, "inbox", "lesson-a.md"), "---\ntype: lesson\n---\n\nbody\n");
	const jobPath = writeWorkerAndJob({
		mode: "fold",
		vaultDir: vault,
		provider: "x",
		modelId: "y",
		threshold: 1,
		force: true,
		pendingPath: join(workDir, ".fold-job.json"),
	});

	expect(runWorker("fold", jobPath)).toBe(0);
	const log = readFileSync(join(vault, "fold.log"), "utf8");
	expect(log).toContain("fake fold output");
	expect(existsSync(join(vault, ".memory-fold.lock"))).toBe(false);
	expect(existsSync(jobPath)).toBe(false);
});

test("fold mode skips when a live process holds the fold lock", () => {
	stubHummin("should not run");
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	mkdirSync(join(vault, "inbox"), { recursive: true });
	writeFileSync(join(vault, "inbox", "lesson-a.md"), "---\ntype: lesson\n---\n\nbody\n");
	mkdirSync(join(vault, ".memory-fold.lock"), { recursive: true });
	writeFileSync(
		join(vault, ".memory-fold.lock", "owner.json"),
		JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
	);
	const jobPath = writeWorkerAndJob({
		mode: "fold",
		vaultDir: vault,
		provider: "x",
		modelId: "y",
		threshold: 1,
		force: true,
		pendingPath: join(workDir, ".fold-job.json"),
	});

	expect(runWorker("fold", jobPath)).toBe(0);
	expect(existsSync(join(vault, "fold.log"))).toBe(false);
});
