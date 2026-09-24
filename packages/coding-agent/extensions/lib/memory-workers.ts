/**
 * Sources for the detached memory workers.
 *
 * The generated program deliberately uses only Node built-ins. The extension
 * writes this source into its memory directory and invokes it with
 * `node worker.mjs <mode> <job.json>`.
 */

export type MemoryWorkerMode = "distill" | "fold" | "prune";

export interface MemoryDistillJob {
	mode: "distill";
	memoryDir: string;
	sessionFile: string;
	cwd: string;
	tail: string;
	provider: string;
	modelId: string;
	project: string;
	session: string;
	vaultMode?: boolean;
	vaultDir?: string;
	pendingPath?: string;
	/** Path to the shared laya-gate.log; the worker appends the intake read's
	 * audit line directly (the worker has no agent-dir lookup). */
	gateLog?: string;
}

export interface MemoryFoldJob {
	mode: "fold";
	vaultDir: string;
	provider: string;
	modelId: string;
	threshold?: number;
	force?: boolean;
	label?: string;
	/** Job file the parent wrote; removed once the fold has run. */
	pendingPath?: string;
}

export interface MemoryPruneJob {
	mode: "prune";
	memoryDir: string;
	vaultDir?: string;
}

/**
 * Pure usage-aware decay policy for the lessons store. Given lessons.jsonl
 * lines in file order (oldest first), returns the indices to KEEP. Under both
 * caps everything is kept. Over a cap, records with no lastInjectedAt inside
 * the pin window (missing or stale) drop oldest first; only if still over cap
 * do the oldest pinned (recently injected) records drop.
 *
 * The detached worker is a dependency-free generated file, so its source is
 * embedded verbatim into MEMORY_WORKER_SOURCE via Function.prototype.toString:
 * this declaration is the single implementation. Keep it self-contained - no
 * outer-scope references, no imports, no syntax the raw Node runtime lacks.
 */
export function decayKeepIndices(lines: string[], maxRecords: number, maxBytes: number, now: number, pinDays = 30): number[] {
	const pinMs = pinDays * 86400000;
	const entries = lines.map((line) => {
		let pinned = false;
		try {
			const injected = JSON.parse(line).lastInjectedAt;
			if (typeof injected === "string") {
				const then = Date.parse(injected);
				pinned = Number.isFinite(then) && now - then < pinMs;
			}
		} catch {
			// unparseable line counts as never injected
		}
		return { pinned, bytes: Buffer.byteLength(line + "\n") };
	});
	let totalBytes = 0;
	for (const entry of entries) totalBytes += entry.bytes;
	if (entries.length <= maxRecords && totalBytes <= maxBytes) return entries.map((unused, index) => index);
	const unpinned: number[] = [];
	const pinned: number[] = [];
	for (let index = 0; index < entries.length; index++) (entries[index].pinned ? pinned : unpinned).push(index);
	const keep = new Set<number>();
	for (let index = 0; index < entries.length; index++) keep.add(index);
	let count = entries.length;
	let bytes = totalBytes;
	for (const index of unpinned.concat(pinned)) {
		if (count <= maxRecords && bytes <= maxBytes) break;
		keep.delete(index);
		count -= 1;
		bytes -= entries[index].bytes;
	}
	return [...keep].sort((a, b) => a - b);
}

/** A single source handles all modes so parent code only manages one file. */
export const MEMORY_WORKER_SOURCE = String.raw`#!/usr/bin/env node
// Machine-managed by hummin-memory. Do not edit.
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const LESSON_MAX_WORDS = 120;
const LESSON_MAX_RECORDS = 1000;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_FOLD_LOG_BYTES = 1024 * 1024;
const CHILD_MAX_BUFFER = 256 * 1024;
const DISTILL_TIMEOUT_MS = 300000;
const FOLD_TIMEOUT_MS = 900000;
const INTAKE_TIMEOUT_MS = 6000;
const INTAKE_THRESHOLD = 0.5;

// Usage-aware decay policy, embedded verbatim from memory-workers.ts (single
// implementation; see decayKeepIndices there).
${decayKeepIndices}

const mode = process.argv[2];
const jobPath = process.argv[3];
if (!mode || !jobPath) process.exit(2);

let job;
try {
	job = JSON.parse(readFileSync(jobPath, "utf8"));
} catch {
	process.exit(2);
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function pidIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && error.code !== "ESRCH";
	}
}

// Locks are directories created with mkdir, which is atomic across processes.
// A live owner always wins; age is never used to take a lock from a live PID.
function acquireLock(lockPath) {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 32; attempt++) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
			return true;
		} catch (error) {
			if (!error || error.code !== "EEXIST") return false;
		}

		let owner;
		try {
			owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
		} catch {
			owner = undefined;
		}
		if (owner && pidIsAlive(owner.pid)) return false;

		// An owner that has exited left a stale directory. Rename first so a
		// concurrent waiter cannot delete a newly acquired lock.
		const stalePath = lockPath + ".stale-" + process.pid + "-" + attempt;
		try {
			renameSync(lockPath, stalePath);
			rmSync(stalePath, { recursive: true, force: true });
		} catch {
			// Another waiter won the stale-lock race; retry the live-owner check.
		}
	}
	return false;
}

function releaseLock(lockPath) {
	try {
		const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
		if (owner.pid !== process.pid) return;
	} catch {
		// If the owner file was never written, this process still owns the mkdir.
	}
	rmSync(lockPath, { recursive: true, force: true });
}

function withLock(lockPath, fn) {
	if (!acquireLock(lockPath)) return { acquired: false, value: undefined };
	try {
		return { acquired: true, value: fn() };
	} finally {
		releaseLock(lockPath);
	}
}

function atomicWrite(path, text) {
	const temp = path + ".tmp-" + process.pid;
	writeFileSync(temp, text);
	renameSync(temp, path);
}

function readState(memoryDir) {
	try {
		const state = JSON.parse(readFileSync(join(memoryDir, "state.json"), "utf8"));
		return state && typeof state === "object" ? state : {};
	} catch {
		return {};
	}
}

function readTailBytes(path, maxBytes) {
	try {
		const size = statSync(path).size;
		const fd = openSync(path, "r");
		try {
			const length = Math.min(size, maxBytes);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, Math.max(0, size - length));
			return buffer;
		} finally {
			import("node:fs").then(({ closeSync }) => closeSync(fd)).catch(() => {});
		}
	} catch {
		return Buffer.alloc(0);
	}
}

function boundedFile(path, maxBytes) {
	if (!existsSync(path)) return;
	const tail = readTailBytes(path, maxBytes);
	if (tail.length <= maxBytes) {
		const currentSize = statSync(path).size;
		if (currentSize === tail.length) return;
	}
	const temp = path + ".tmp-" + process.pid;
	writeFileSync(temp, tail);
	renameSync(temp, path);
}

function boundedLessons(memoryDir) {
	const path = join(memoryDir, "lessons.jsonl");
	if (!existsSync(path)) return;
	let lines;
	try {
		lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim());
	} catch {
		return;
	}
	// Usage-aware decay: prefer dropping never-injected (or stale) records,
	// oldest first; only then drop the oldest recently injected records.
	const keep = new Set(decayKeepIndices(lines, LESSON_MAX_RECORDS, MAX_STORE_BYTES, Date.now()));
	if (keep.size === lines.length) return;
	const kept = lines.filter((line, index) => keep.has(index));
	atomicWrite(path, kept.length > 0 ? kept.join("\n") + "\n" : "");
}

function boundedFoldLog(vaultDir, output) {
	mkdirSync(vaultDir, { recursive: true });
	const path = join(vaultDir, "fold.log");
	const previous = existsSync(path) ? readTailBytes(path, MAX_FOLD_LOG_BYTES) : Buffer.alloc(0);
	const next = Buffer.concat([previous, Buffer.from(output || "")]);
	const bounded = next.length > MAX_FOLD_LOG_BYTES ? next.subarray(next.length - MAX_FOLD_LOG_BYTES) : next;
	const text = bounded.length > 0 ? Buffer.concat([bounded, Buffer.from(bounded[bounded.length - 1] === 10 ? "" : "\n")]) : bounded;
	const temp = path + ".tmp-" + process.pid;
	writeFileSync(temp, text);
	renameSync(temp, path);
}

function removePending() {
	if (typeof job.pendingPath !== "string") return;
	try { rmSync(job.pendingPath, { force: true }); } catch {}
}

// Every laya read is audited to the shared laya-gate.log; the worker appends
// directly and never lets a logging failure break the run.
function auditRead(gateLog, kind, p) {
	if (typeof gateLog !== "string") return;
	try { appendFileSync(gateLog, JSON.stringify({ ts: new Date().toISOString(), type: "read", kind, p }) + "\n"); } catch {}
}

// One laya read gating lesson intake: a score >= INTAKE_THRESHOLD stores the
// lesson, below drops it exactly like a NONE reply. Any failure (missing key,
// unreachable, timeout, parse) returns null and the lesson is stored - fail
// open. HUMMIN_LAYA_INTAKE=off skips the read entirely.
async function layaIntakeScore(lesson) {
	if (String(process.env.HUMMIN_LAYA_INTAKE || "").trim().toLowerCase() === "off") return null;
	const apiKey = String(process.env.COLI_API_KEY || "").trim();
	if (!apiKey) return null;
	const url = String(process.env.HUMMIN_LAYA_URL || "").trim() || "http://127.0.0.1:9989/v1/systemone";
	const state = "A coding agent distilled the following lesson from a finished session in " + job.cwd + ". Decide whether it is durable project knowledge.\n\n" + lesson.slice(0, 4000);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
			body: JSON.stringify({
				state,
				questions: {
					durable: {
						type: "noul",
						instructions: "Score the probability that this lesson is durable project knowledge a future session in this project would need, rather than session-specific noise. Trivial recounts of what was done, transient state, and one-off chores must score LOW.",
					},
				},
			}),
			signal: AbortSignal.timeout(INTAKE_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const payload = await response.json();
		const answer = payload && payload.answers && payload.answers.durable;
		if (!answer || typeof answer.noul !== "number") return null;
		auditRead(job.gateLog, "intake", answer.noul);
		return answer.noul;
	} catch {
		return null;
	}
}

async function distill() {
	const memoryDir = job.memoryDir;
	mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
	const sessionLock = join(memoryDir, ".locks", "distill-" + hash(String(job.sessionFile)) + ".lock");
	if (!acquireLock(sessionLock)) return 0;
	try {
		const initialState = readState(memoryDir);
		if (initialState.processed && initialState.processed[job.sessionFile]) {
			removePending();
			return 0;
		}
		const prompt = [
			"You are distilling a coding-agent session into exactly one reusable lesson.",
			"",
			"Rules:",
			"- Reply with ONLY the lesson in this exact shape:",
			"Problem: <what the session was trying to do>",
			"Approach: <what actually worked>",
			"Gotcha: <the non-obvious thing a future session would need>",
			"- Max " + LESSON_MAX_WORDS + " words total.",
			"- If there is no real lesson worth keeping, reply with exactly: NONE",
			"",
			"Working directory: " + job.cwd,
			"",
			"Session transcript (tail):",
			job.tail || "",
		].join("\n");
		const result = spawnSync("hummin", ["-p", prompt, "--provider", job.provider, "--model", job.modelId, "--thinking", "low"], {
			encoding: "utf8",
			timeout: DISTILL_TIMEOUT_MS,
			maxBuffer: CHILD_MAX_BUFFER,
			env: { ...process.env, HUMMIN_MEMORY: "0" },
		});
		const output = String(result.stdout || "").trim();
		if (result.error || result.status !== 0 || !output) return 1;
		if (/^NONE$/i.test(output.split("\n").at(-1)?.trim() || "")) {
			removePending();
			return 0;
		}
		const intake = await layaIntakeScore(output);
		if (intake !== null && intake < INTAKE_THRESHOLD) {
			removePending();
			return 0;
		}

		const storeLock = join(memoryDir, ".locks", "store.lock");
		const stored = withLock(storeLock, () => {
			const state = readState(memoryDir);
			if (state.processed && state.processed[job.sessionFile]) return true;
			// This also closes the crash window between appending a record and
			// atomically replacing state.json.
			try {
				for (const line of readFileSync(join(memoryDir, "lessons.jsonl"), "utf8").split(/\r?\n/)) {
					try {
						if (JSON.parse(line).sessionFile === job.sessionFile) {
							state.processed = state.processed || {};
							state.processed[job.sessionFile] = new Date().toISOString();
							atomicWrite(join(memoryDir, "state.json"), JSON.stringify(state, null, 1));
							return true;
						}
					} catch {}
				}
			} catch {}
			mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
			const now = new Date().toISOString();
			const record = { timestamp: now, cwd: job.cwd, project: job.project, session: job.session, sessionFile: job.sessionFile, lesson: output };
			appendFileSync(join(memoryDir, "lessons.jsonl"), JSON.stringify(record) + "\n");
			const markdownPath = join(memoryDir, String(job.project).replace(/[^a-zA-Z0-9._-]/g, "-") + ".lessons.md");
			if (!existsSync(markdownPath)) writeFileSync(markdownPath, "# Lessons - " + job.cwd + "\n\n");
			appendFileSync(markdownPath, "## " + now + "\n\n" + output + "\n\n");
			state.processed = state.processed || {};
			state.processed[job.sessionFile] = now;
			atomicWrite(join(memoryDir, "state.json"), JSON.stringify(state, null, 1));
			boundedLessons(memoryDir);
			if (job.vaultMode && job.vaultDir) {
				const inbox = join(job.vaultDir, "inbox");
				mkdirSync(inbox, { recursive: true });
				const base = "lesson-" + now.replace(/[:.]/g, "-");
				let inboxPath = join(inbox, base + ".md");
				let suffix = 0;
				while (existsSync(inboxPath)) inboxPath = join(inbox, base + "-" + (++suffix) + ".md");
				writeFileSync(inboxPath, ["---", "type: lesson", "date: " + now.slice(0, 10), "project: " + job.cwd, "session: " + (job.session || "unknown"), "---", "", output, ""].join("\n"));
			}
			return true;
		});
		if (!stored.acquired || !stored.value) return 1;
		removePending();
		return 0;
	} finally {
		releaseLock(sessionLock);
	}
}

function inboxCount(vaultDir) {
	try { return readdirSync(join(vaultDir, "inbox")).filter((entry) => entry.endsWith(".md")).length; } catch { return 0; }
}

function fold() {
	const vaultDir = job.vaultDir;
	const lockPath = join(vaultDir, ".memory-fold.lock");
	if (!acquireLock(lockPath)) return 0;
	try {
		const count = inboxCount(vaultDir);
		const threshold = job.force ? 1 : Math.max(1, Number(job.threshold || 3));
		if (count < threshold) return 0;
		const prompt = "Fold the inbox lessons into the entity graph now, following AGENTS.md exactly. Inbox has " + count + " lesson(s).";
		const result = spawnSync("hummin", ["-p", prompt, "--provider", job.provider, "--model", job.modelId, "--thinking", "low"], {
			cwd: vaultDir,
			encoding: "utf8",
			timeout: FOLD_TIMEOUT_MS,
			maxBuffer: CHILD_MAX_BUFFER,
			env: { ...process.env, HUMMIN_MEMORY: "0" },
		});
		const output = String(result.stdout || "") + String(result.stderr || "") + (result.error ? "\n" + String(result.error) : "");
		boundedFoldLog(vaultDir, output);
		return result.error || result.status !== 0 ? 1 : 0;
	} finally {
		releaseLock(lockPath);
		removePending();
	}
}

function prune() {
	if (typeof job.memoryDir === "string") {
		mkdirSync(job.memoryDir, { recursive: true, mode: 0o700 });
		const storeLock = join(job.memoryDir, ".locks", "store.lock");
		const result = withLock(storeLock, () => {
			boundedLessons(job.memoryDir);
			return true;
		});
		if (!result.acquired) return 1;
	}
	if (typeof job.vaultDir === "string") {
		const lockPath = join(job.vaultDir, ".memory-fold.lock");
		const result = withLock(lockPath, () => {
			boundedFoldLog(job.vaultDir, "");
			return true;
		});
		if (!result.acquired) return 1;
	}
	return 0;
}

let exitCode = 2;
try {
	if (mode === "distill") exitCode = await distill();
	else if (mode === "fold") exitCode = fold();
	else if (mode === "prune") exitCode = prune();
} catch (error) {
	process.stderr.write(String(error && error.stack || error) + "\n");
	exitCode = 1;
}
process.exitCode = exitCode;
`;

// Named aliases make migration from the old two-source implementation easy.
export const DISTILL_WORKER_SOURCE = MEMORY_WORKER_SOURCE;
export const FOLD_WORKER_SOURCE = MEMORY_WORKER_SOURCE;
