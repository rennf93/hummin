import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";
import { lastFoldValidation } from "../extensions/hummin-memory.ts";
import {
	decayKeepIndices,
	foldValidationFailures,
	lastCompactionSummary,
	MEMORY_WORKER_SOURCE,
	parseDistilledLessons,
} from "../extensions/lib/memory-workers.ts";

// Fresh temp dirs per test: the worker source and job files are written into
// the memory dir; fold output goes into the vault dir. Never the real store.
const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;
let pathOriginal: string | undefined;
let workDir: string;
let lastHumminArgsPath: string | undefined;

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
	lastHumminArgsPath = join(workDir, "hummin-args");
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${lastHumminArgsPath}"\necho "${output}"\n`);
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

function runWorker(mode: "fold" | "prune" | "distill", jobPath: string): number {
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
	expect(readFileSync(lastHumminArgsPath!, "utf8").split("\n")).toEqual(expect.arrayContaining(["--thinking", "low"]));
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

// --- Usage-aware decay policy ------------------------------------------------

const NOW = Date.parse("2026-09-24T00:00:00.000Z");
const FRESH = new Date(NOW - 86_400_000).toISOString();
const STALE = new Date(NOW - 40 * 86_400_000).toISOString();

function decayLine(lesson: string, lastInjectedAt?: string): string {
	return JSON.stringify(lastInjectedAt === undefined ? { cwd: "/p", lesson } : { cwd: "/p", lesson, lastInjectedAt });
}

test("decayKeepIndices keeps everything when under both caps", () => {
	const lines = [decayLine("a"), decayLine("b", FRESH)];
	expect(decayKeepIndices(lines, 1000, 1024 * 1024, NOW)).toEqual([0, 1]);
});

test("decayKeepIndices drops never-injected records oldest first before pinned ones", () => {
	// The pinned records are the OLDEST in the file; the cap still drops the
	// newest of the never-injected ones and keeps every pinned record.
	const lines = [
		decayLine("pinned-0", FRESH),
		decayLine("pinned-1", FRESH),
		decayLine("plain-0"),
		decayLine("plain-1"),
		decayLine("plain-2"),
	];
	expect(decayKeepIndices(lines, 3, 1024 * 1024, NOW)).toEqual([0, 1, 4]);
});

test("decayKeepIndices treats lastInjectedAt outside the pin window as never injected", () => {
	const lines = [decayLine("stale", STALE), decayLine("fresh", FRESH), decayLine("plain"), decayLine("plain-too")];
	// Cap 2: unpinned records drop oldest first (stale, then plain), leaving
	// the fresh one and the newest plain record.
	expect(decayKeepIndices(lines, 2, 1024 * 1024, NOW)).toEqual([1, 3]);
});

test("decayKeepIndices tolerates malformed lines and non-string stamps as unpinned", () => {
	const lines = [
		"not json",
		JSON.stringify({ cwd: "/p", lesson: "x", lastInjectedAt: 42 }),
		decayLine("fresh", FRESH),
		decayLine("plain"),
	];
	expect(decayKeepIndices(lines, 2, 1024 * 1024, NOW)).toEqual([2, 3]);
});

test("decayKeepIndices falls back to dropping the oldest pinned records when all are pinned", () => {
	const lines = [decayLine("a", FRESH), decayLine("b", FRESH), decayLine("c", FRESH)];
	expect(decayKeepIndices(lines, 1, 1024 * 1024, NOW)).toEqual([2]);
});

test("decayKeepIndices enforces the byte cap before the record cap", () => {
	const small = JSON.stringify({ cwd: "/p", lesson: "tiny" });
	const big = JSON.stringify({ cwd: "/p", lesson: "x".repeat(200) });
	const lines = [decayLine("pinned", FRESH), big, small];
	// Byte cap 250: the big unpinned record drops before the small one.
	expect(decayKeepIndices(lines, 3, 250, NOW)).toEqual([0, 2]);
});

test("prune mode keeps recently injected lessons over never-injected ones when over the record cap", () => {
	const memory = process.env.HUMMIN_MEMORY_DIR!;
	const records: Array<Record<string, unknown>> = [];
	for (let i = 0; i < 10; i++)
		records.push({ timestamp: FRESH, cwd: "/p", lesson: `pinned lesson ${i}`, lastInjectedAt: FRESH });
	for (let i = 0; i < 995; i++) records.push({ timestamp: FRESH, cwd: "/p", lesson: `plain lesson ${i}` });
	writeFileSync(join(memory, "lessons.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const jobPath = writeWorkerAndJob({ mode: "prune", memoryDir: memory });

	expect(runWorker("prune", jobPath)).toBe(0);
	const lines = readFileSync(join(memory, "lessons.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1000);
	const lessons = lines.map((l) => JSON.parse(l).lesson as string);
	// Every pinned record survives even though they are the oldest lines.
	for (let i = 0; i < 10; i++) expect(lessons).toContain(`pinned lesson ${i}`);
	// The overflow comes off the oldest never-injected records.
	for (let i = 0; i < 5; i++) expect(lessons).not.toContain(`plain lesson ${i}`);
	expect(lessons).toContain("plain lesson 5");
});

// --- Distill reply parsing (up to three lessons) ------------------------------

test("parseDistilledLessons keeps the prompt's multi-line shape as one lesson per Problem", () => {
	const reply = [
		"1. Problem: first lesson body",
		"   Approach: first approach",
		"   Gotcha: first gotcha",
		"2. Problem: second lesson body",
		"   Approach: second approach",
		"   Gotcha: second gotcha",
	].join("\n");
	expect(parseDistilledLessons(reply)).toEqual([
		"Problem: first lesson body\n   Approach: first approach\n   Gotcha: first gotcha",
		"Problem: second lesson body\n   Approach: second approach\n   Gotcha: second gotcha",
	]);
});

test("parseDistilledLessons caps at three lessons", () => {
	const reply = Array.from({ length: 4 }, (_, i) => `${i + 1}. Problem: lesson ${i + 1}`).join("\n");
	const parsed = parseDistilledLessons(reply);
	expect(parsed).toHaveLength(3);
	expect(parsed[2]).toBe("Problem: lesson 3");
});

test("parseDistilledLessons tolerates fences, bold markers, and Lesson N titles", () => {
	const reply = [
		"Here are the lessons:",
		"```",
		"1. **Problem:** fenced one",
		"   Approach: fenced approach",
		"**Lesson 2**",
		"2) Problem: fenced two",
		"```",
	].join("\n");
	expect(parseDistilledLessons(reply)).toEqual([
		"Problem: fenced one\n   Approach: fenced approach",
		"Problem: fenced two",
	]);
});

test("parseDistilledLessons returns [] for NONE and collapses duplicate lessons", () => {
	expect(parseDistilledLessons("NONE")).toEqual([]);
	const dup = "1. Problem: same\n   Approach: a\n2. Problem: same\n   Approach: a";
	expect(parseDistilledLessons(dup)).toHaveLength(1);
	expect(parseDistilledLessons("no lesson shape here at all")).toEqual([]);
});

test("parseDistilledLessons starts a new lesson at numbered or bulleted Gotcha lines", () => {
	const reply = "1. Gotcha: first gotcha-only lesson\n2. Gotcha: second gotcha-only lesson";
	expect(parseDistilledLessons(reply)).toEqual([
		"Gotcha: first gotcha-only lesson",
		"Gotcha: second gotcha-only lesson",
	]);
});

test("parseDistilledLessons keeps a single one-line reply intact", () => {
	expect(parseDistilledLessons(LESSON)).toEqual([LESSON]);
});

// --- Distill mode: laya-gated lesson intake -----------------------------------

const LESSON = "Problem: one. Approach: two. Gotcha: three.";

/** Local stand-in for the laya service answering the intake question. */
function startLayaStub(noul: number): Promise<{ server: Server; url: string; requests: string[] }> {
	return new Promise((resolve) => {
		const requests: string[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk;
			});
			req.on("end", () => {
				requests.push(body);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ answers: { durable: { noul } } }));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ server, url: `http://127.0.0.1:${port}/v1/systemone`, requests });
		});
	});
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Async twin of runWorker for the intake tests: the laya stub lives in this
 * test process, and a blocking spawnSync would freeze the event loop so the
 * stub could never answer the worker's request.
 */
function runWorkerAsync(mode: "distill", jobPath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(workDir, "memory-worker.mjs"), mode, jobPath], {
			env: { ...process.env, HUMMIN_MEMORY: "0" },
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => (code === null ? reject(new Error(`worker died: ${stderr}`)) : resolve(code)));
	});
}

function applyEnv(overrides: Record<string, string | undefined>): Map<string, string | undefined> {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function withEnvSync(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved = applyEnv(overrides);
	try {
		fn();
	} finally {
		restoreEnv(saved);
	}
}

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const saved = applyEnv(overrides);
	try {
		return await fn();
	} finally {
		restoreEnv(saved);
	}
}

function distillJob(memory: string): Record<string, unknown> {
	return {
		mode: "distill",
		memoryDir: memory,
		sessionFile: "/p/session-1.jsonl",
		cwd: "/p",
		tail: "USER: fix the thing\nASSISTANT: fixed",
		provider: "x",
		modelId: "y",
		project: "p",
		session: "session-1",
		gateLog: join(memory, "laya-gate.log"),
	};
}

test("distill mode stores the lesson and audits the intake read when laya scores at the threshold or above", async () => {
	stubHummin(LESSON);
	const memory = process.env.HUMMIN_MEMORY_DIR!;
	const laya = await startLayaStub(0.9);
	try {
		const jobPath = writeWorkerAndJob(distillJob(memory));
		await withEnv(
			{ COLI_API_KEY: "test-key", HUMMIN_LAYA_URL: laya.url, HUMMIN_LAYA_INTAKE: undefined },
			async () => {
				expect(await runWorkerAsync("distill", jobPath)).toBe(0);
			},
		);
		const lines = readFileSync(join(memory, "lessons.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).lesson).toBe(LESSON);
		// The read reaches laya as a noul question and is audited to the gate log.
		expect(laya.requests).toHaveLength(1);
		expect(JSON.parse(laya.requests[0]).questions.durable.type).toBe("noul");
		const audit = JSON.parse(readFileSync(join(memory, "laya-gate.log"), "utf8").trim().split("\n").at(-1)!);
		expect(audit).toMatchObject({ type: "read", kind: "intake", p: 0.9 });
	} finally {
		await closeServer(laya.server);
	}
});

test("distill mode stores nothing when the intake read scores below the threshold, like the NONE gate", async () => {
	stubHummin(LESSON);
	const memory = process.env.HUMMIN_MEMORY_DIR!;
	const laya = await startLayaStub(0.3);
	try {
		const jobPath = writeWorkerAndJob(distillJob(memory));
		await withEnv(
			{ COLI_API_KEY: "test-key", HUMMIN_LAYA_URL: laya.url, HUMMIN_LAYA_INTAKE: undefined },
			async () => {
				expect(await runWorkerAsync("distill", jobPath)).toBe(0);
			},
		);
		expect(existsSync(join(memory, "lessons.jsonl"))).toBe(false);
		expect(existsSync(join(memory, "state.json"))).toBe(false);
		// The read itself is still audited (every laya read is).
		const audit = JSON.parse(readFileSync(join(memory, "laya-gate.log"), "utf8").trim().split("\n").at(-1)!);
		expect(audit).toMatchObject({ type: "read", kind: "intake", p: 0.3 });
	} finally {
		await closeServer(laya.server);
	}
});

test("distill mode fails open when laya is unreachable or the intake read is switched off", () => {
	for (const env of [
		{ COLI_API_KEY: "test-key", HUMMIN_LAYA_URL: "http://127.0.0.1:9/v1/systemone", HUMMIN_LAYA_INTAKE: undefined },
		{ COLI_API_KEY: undefined, HUMMIN_LAYA_URL: undefined, HUMMIN_LAYA_INTAKE: undefined },
		{ COLI_API_KEY: "test-key", HUMMIN_LAYA_URL: undefined, HUMMIN_LAYA_INTAKE: "off" },
	]) {
		stubHummin(LESSON);
		const memory = process.env.HUMMIN_MEMORY_DIR!;
		const jobPath = writeWorkerAndJob(distillJob(memory));
		withEnvSync(env, () => {
			expect(runWorker("distill", jobPath)).toBe(0);
		});
		expect(readFileSync(join(memory, "lessons.jsonl"), "utf8")).toContain(LESSON);
		expect(existsSync(join(memory, "laya-gate.log"))).toBe(false);
	}
});

test("distill mode stores each lesson of a multi-lesson reply independently", () => {
	stubHummin(
		[
			"1. Problem: first lesson body",
			"   Approach: first approach",
			"   Gotcha: first gotcha",
			"2. Problem: second lesson body",
			"   Approach: second approach",
			"   Gotcha: second gotcha",
		].join("\n"),
	);
	const memory = process.env.HUMMIN_MEMORY_DIR!;
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	// No laya env in play: the intake gate fails open and both lessons store.
	// Pin the gate env OFF - a developer env with COLI_API_KEY and a live laya
	// on the default port would otherwise really score these fake lessons and
	// drop them.
	const jobPath = writeWorkerAndJob({ ...distillJob(memory), vaultMode: true, vaultDir: vault });
	withEnvSync({ COLI_API_KEY: undefined, HUMMIN_LAYA_URL: undefined, HUMMIN_LAYA_INTAKE: undefined }, () => {
		expect(runWorker("distill", jobPath)).toBe(0);
	});
	const lines = readFileSync(join(memory, "lessons.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(2);
	expect(JSON.parse(lines[0]).lesson).toBe(
		"Problem: first lesson body\n   Approach: first approach\n   Gotcha: first gotcha",
	);
	expect(JSON.parse(lines[1]).lesson).toBe(
		"Problem: second lesson body\n   Approach: second approach\n   Gotcha: second gotcha",
	);
	// One mirror section per lesson in the human-readable view.
	const mirror = readFileSync(join(memory, "p.lessons.md"), "utf8");
	expect(mirror.match(/^## /gm)).toHaveLength(2);
	// Vault mode: one inbox file per lesson.
	expect(readdirSync(join(vault, "inbox")).filter((f) => f.endsWith(".md"))).toHaveLength(2);
	// The session is marked processed once, not once per lesson.
	const state = JSON.parse(readFileSync(join(memory, "state.json"), "utf8"));
	expect(state.processed["/p/session-1.jsonl"]).toEqual(expect.any(String));
});

// --- Compaction checkpoint scan (streaming, last entry wins) ------------------

test("lastCompactionSummary returns the last compaction summary, truncated", () => {
	const session = join(workDir, "session.jsonl");
	writeFileSync(
		session,
		[
			JSON.stringify({ type: "message", message: { role: "user" } }),
			JSON.stringify({ type: "compaction", summary: "early checkpoint" }),
			"not json at all",
			JSON.stringify({ type: "compaction", summary: "x".repeat(5000) }),
			JSON.stringify({ type: "message" }),
		].join("\n"),
	);
	expect(lastCompactionSummary(session, 4000)).toBe("x".repeat(4000));
});

test("lastCompactionSummary reads a chunk-straddling compaction line", () => {
	const session = join(workDir, "big-session.jsonl");
	const chunkBytes = 256 * 1024;
	const early = JSON.stringify({ type: "compaction", summary: "early one" });
	const last = JSON.stringify({ type: "compaction", summary: "final checkpoint" });
	// Pad so the last compaction line starts 10 bytes before the first chunk
	// boundary and spans it: only chunked reading can see it whole.
	const padLength = chunkBytes - early.length - 12;
	writeFileSync(session, [early, "p".repeat(padLength), last].join("\n"));
	expect(lastCompactionSummary(session, 4000)).toBe("final checkpoint");
});

test("lastCompactionSummary fails open on a missing file or a file without compaction", () => {
	expect(lastCompactionSummary(join(workDir, "missing.jsonl"))).toBeNull();
	const session = join(workDir, "plain.jsonl");
	writeFileSync(session, `${JSON.stringify({ type: "message" })}\n`);
	expect(lastCompactionSummary(session)).toBeNull();
});

test("distill mode prepends the last compaction checkpoint to the prompt", () => {
	stubHummin(LESSON);
	const memory = process.env.HUMMIN_MEMORY_DIR!;
	const sessionFile = join(workDir, "session.jsonl");
	writeFileSync(
		sessionFile,
		[
			JSON.stringify({ type: "message" }),
			JSON.stringify({ type: "compaction", summary: "The session earlier rebuilt the docker fleet." }),
			JSON.stringify({ type: "message" }),
		].join("\n"),
	);
	const jobPath = writeWorkerAndJob({ ...distillJob(memory), sessionFile });
	// Gate env pinned off: the assertions here are about the prompt, and a
	// developer-env laya must not be contacted from this test.
	withEnvSync({ COLI_API_KEY: undefined, HUMMIN_LAYA_URL: undefined, HUMMIN_LAYA_INTAKE: undefined }, () => {
		expect(runWorker("distill", jobPath)).toBe(0);
	});
	const prompt = readFileSync(lastHumminArgsPath!, "utf8");
	expect(prompt).toContain("Earlier session checkpoint (from compaction):");
	expect(prompt).toContain("The session earlier rebuilt the docker fleet.");
	expect(prompt.indexOf("Earlier session checkpoint")).toBeLessThan(prompt.indexOf("Session transcript (tail):"));
});

test("distill mode omits the checkpoint section when the session has none", () => {
	stubHummin(LESSON);
	const memory = process.env.HUMMIN_MEMORY_DIR!;
	// distillJob points sessionFile at the nonexistent /p/session-1.jsonl: the
	// scan fails open and the prompt carries only the transcript tail. The gate
	// env is pinned off so a developer-env laya cannot drop the lesson (see the
	// multi-lesson test above).
	const jobPath = writeWorkerAndJob(distillJob(memory));
	withEnvSync({ COLI_API_KEY: undefined, HUMMIN_LAYA_URL: undefined, HUMMIN_LAYA_INTAKE: undefined }, () => {
		expect(runWorker("distill", jobPath)).toBe(0);
	});
	expect(readFileSync(lastHumminArgsPath!, "utf8")).not.toContain("Earlier session checkpoint");
	expect(readFileSync(join(memory, "lessons.jsonl"), "utf8")).toContain(LESSON);
});

// --- Fold validation (pure checks + worker pass + one repair retry) -----------

test("foldValidationFailures checks worktree, inbox drain, and entity citations", () => {
	const base = {
		porcelain: "",
		inboxBefore: 2,
		inboxAfter: 0,
		movedSlugs: ["lesson-a.md"],
		entityBodies: ["- fact (from [[lesson-a]], 2026-09-26)"],
	};
	expect(foldValidationFailures(base)).toEqual([]);
	expect(foldValidationFailures({ ...base, porcelain: "?? fold.log\n" })).toEqual(["git worktree dirty after fold"]);
	expect(foldValidationFailures({ ...base, inboxAfter: 2 })).toEqual(["inbox count did not decrease (2 -> 2)"]);
	expect(foldValidationFailures({ ...base, entityBodies: [] })).toEqual([
		"no entity references moved lesson lesson-a",
	]);
	// alias, anchor, and case-insensitive wikilinks all count as citations
	expect(foldValidationFailures({ ...base, entityBodies: ["see [[lesson-a|the quota note]] here"] })).toEqual([]);
	expect(foldValidationFailures({ ...base, entityBodies: ["see [[lesson-a#facts]] here"] })).toEqual([]);
	expect(foldValidationFailures({ ...base, entityBodies: ["see [[Lesson-A]] here"] })).toEqual([]);
});

/** A stub `hummin` that really folds (moves inbox files, cites them from an
 * entity, commits) when HUMMIN_FOLD_STUB_WORK=1, and counts its calls. */
function stubFoldingHummin(): string {
	const bin = join(workDir, "bin-fold");
	mkdirSync(bin, { recursive: true });
	const marker = join(workDir, "hummin-calls");
	const script = join(bin, "hummin");
	writeFileSync(
		script,
		`#!/bin/sh
printf 'call\\n' >> "${marker}"
if [ -n "$HUMMIN_FOLD_STUB_WORK" ]; then
  mkdir -p processed entities/project
  for f in inbox/*.md; do
    [ -e "$f" ] || continue
    base=$(basename "$f" .md)
    mv "$f" "processed/$base"
    printf 'fact (from [[%s]], 2026-09-26)\\n' "$base" >> "entities/project/stub-entity.md"
  done
  git add -A
  git -c user.email=stub@example.com -c user.name=stub commit -qm "fold: stub"
fi
echo "stub fold output"
`,
	);
	chmodSync(script, 0o755);
	process.env.PATH = `${bin}:${pathOriginal ?? ""}`;
	return marker;
}

function writeFoldJob(): string {
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	return writeWorkerAndJob({
		mode: "fold",
		vaultDir: vault,
		provider: "x",
		modelId: "y",
		threshold: 1,
		force: true,
		pendingPath: join(workDir, ".fold-job.json"),
	});
}

test("fold mode validates a correct fold and records an ok pass", () => {
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	mkdirSync(join(vault, "inbox"), { recursive: true });
	writeFileSync(join(vault, "inbox", "lesson-a.md"), "---\ntype: lesson\n---\n\nbody\n");
	spawnSync("git", ["init", "-q"], { cwd: vault });
	const marker = stubFoldingHummin();
	const saved = applyEnv({ HUMMIN_FOLD_STUB_WORK: "1" });
	const jobPath = writeFoldJob();
	try {
		expect(runWorker("fold", jobPath)).toBe(0);
	} finally {
		restoreEnv(saved);
	}
	// One child run: validation passed, so no repair retry happened.
	expect(
		readFileSync(marker, "utf8")
			.split("\n")
			.filter((line) => line === "call"),
	).toHaveLength(1);
	const log = readFileSync(join(vault, "fold.log"), "utf8");
	expect(log).toContain('"ok":true');
	expect(log).not.toContain("fold-repair");
	expect(log).not.toContain("fold-validation failed");
	expect(lastFoldValidation(join(vault, "fold.log"))).toEqual({ ok: true, failed: [] });
});

test("fold mode records failures, repairs exactly once, then stops", () => {
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	mkdirSync(join(vault, "inbox"), { recursive: true });
	writeFileSync(join(vault, "inbox", "lesson-a.md"), "body\n");
	writeFileSync(join(vault, "inbox", "lesson-b.md"), "body\n");
	spawnSync("git", ["init", "-q"], { cwd: vault });
	// No HUMMIN_FOLD_STUB_WORK: the fold child does nothing, so validation
	// fails on the first pass and after the single repair.
	const marker = stubFoldingHummin();
	const jobPath = writeFoldJob();
	expect(runWorker("fold", jobPath)).toBe(0);
	const calls = readFileSync(marker, "utf8")
		.split("\n")
		.filter((line) => line === "call");
	expect(calls).toHaveLength(2);
	const log = readFileSync(join(vault, "fold.log"), "utf8");
	expect(log).toContain("fold-repair");
	expect(log).toContain('"ok":false');
	expect(log.trimEnd().endsWith("fold-validation failed")).toBe(true);
	expect(lastFoldValidation(join(vault, "fold.log"))).toEqual({ ok: false, failed: [] });
});

test("lastFoldValidation reads the last marker only", () => {
	const log = join(workDir, "fold.log");
	writeFileSync(
		log,
		[
			"child noise",
			'fold-validation {"attempt":1,"ok":false,"failed":["dirty"]}',
			"more child noise",
			`fold-validation ${JSON.stringify({ attempt: 2, ok: true, failed: [] })}`,
		].join("\n"),
	);
	expect(lastFoldValidation(log)).toEqual({ ok: true, failed: [] });
	writeFileSync(log, ['fold-validation {"ok":true,"failed":[]}', "fold-validation failed"].join("\n"));
	expect(lastFoldValidation(log)).toEqual({ ok: false, failed: [] });
	expect(lastFoldValidation(join(workDir, "nope.log"))).toBeNull();
});
