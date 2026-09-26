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
	thinking: string;
	receipt?: unknown;
	reviewId?: string;
	dispatchReason?: string;
	project: string;
	session: string;
	vaultMode?: boolean;
	vaultDir?: string;
	pendingPath?: string;
	/** Path to the shared laya-gate.log; the worker appends the intake read's
	 * audit line directly (the worker has no agent-dir lookup). */
	gateLog?: string;
	/** Present only while a dispatch hold keeps the job from running. A held
	 * job is retried once by the parent's startup sweep (retryHeldDistills),
	 * which clears these fields when the retry is allowed and deletes the job
	 * otherwise. */
	held?: boolean;
	heldReason?: string;
	heldAt?: string;
	heldRetries?: number;
}

export interface MemoryFoldJob {
	mode: "fold";
	vaultDir: string;
	provider: string;
	modelId: string;
	thinking: string;
	receipt?: unknown;
	reviewId?: string;
	dispatchReason?: string;
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

/**
 * Pure parser for the distill worker's reply, embedded verbatim into
 * MEMORY_WORKER_SOURCE like decayKeepIndices: keep it self-contained - no
 * outer-scope references, no imports, no syntax the raw Node runtime lacks.
 *
 * Accepts "up to N lessons" replies in sloppy shapes: markdown fences, bold
 * markers, standalone "Lesson 2:" title lines, and 1. / 1) / - numbering.
 * Each lesson starts at a Problem: line, at a numbered or bulleted shape line,
 * or at a title line; an unnumbered indented Approach:/Gotcha: line continues
 * the lesson it sits under (the prompt's own multi-line shape) instead of
 * splitting it into fragments. Title/numbering before a body is dropped.
 * Exact duplicates collapse; output is capped at maxLessons. Returns [] for
 * NONE replies and for replies without any lesson shape (the worker then
 * stores the raw output, preserving the old single-lesson fallback).
 */
export function parseDistilledLessons(output: string, maxLessons = 3): string[] {
	// Strip numbering, bullets, and bold markers from a lesson's first line
	// ("1. **Problem:** x" -> "Problem: x") so stored bodies keep the
	// canonical Problem:/Approach:/Gotcha: shape.
	function cleanFirstLessonLine(line: string): string {
		return line
			.replace(/^[ \t]*(?:\d{1,2}[.)][ \t]+)?/, "")
			.replace(/^(?:[-*+][ \t]+)?/, "")
			.replace(/\*+(?=[ \t]*(?:problem|approach|gotcha)[ \t]*:)/i, "")
			.replace(/^((?:problem|approach|gotcha)[ \t]*:[ \t]*)\*+/i, "$1");
	}
	const text = output.replace(/\r\n/g, "\n").trim();
	if (!text) return [];
	const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
	if (/^none\b/i.test(firstLine)) return [];
	// Fenced blocks win when they carry lesson bodies (models often wrap the
	// whole reply in fences); otherwise fence markers stay and the line
	// patterns below simply ignore them.
	const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n");
	const source = /\b(?:problem|approach|gotcha)\s*:/i.test(fenced) ? fenced : text;
	// A lesson starts at a "Problem:" line, at an explicitly delimited shape
	// line ("1. Approach:", "- Gotcha:"), or at a "Lesson 2:" title. A bare
	// indented "Approach:"/"Gotcha:" line continues the currently open lesson
	// (the prompt's shape indents them under their Problem: line) and only
	// starts a lesson when none is open. Numbered/bulleted shape lines must
	// start a lesson: they are list separators even for Gotcha-only replies.
	const shapeLine = /^[\s>#]*(?:[*-]\s*)?(?:\d{1,2}[.)]\s*)?(?:\*\*)?(?:lesson\s*\d{1,2}\s*[:.)-]?\s*)?(?:\*\*)?\s*(?:problem|approach|gotcha)\s*:/i;
	const problemLine = /^[\s>#]*(?:\*\*)?\s*problem\s*:/i;
	const delimitedLine = /^[\s>#]*(?:\d{1,2}[.)]|[*+-])\s+(?:\*\*)?\s*(?:problem|approach|gotcha)\s*:/i;
	const title = /^[\s>#*-]*(?:\*\*)?lesson\s*\d{1,2}\s*[:.)-]?\s*(?:\*\*)?$/i;
	const chunks: string[][] = [];
	for (const line of source.split("\n")) {
		if (title.test(line) || problemLine.test(line) || delimitedLine.test(line) || (chunks.length === 0 && shapeLine.test(line))) chunks.push([]);
		chunks[chunks.length - 1]?.push(line);
	}
	const lessons: string[] = [];
	for (const chunk of chunks) {
		// Skip a "Lesson N" title and any numbering/blank lines before the
		// first shape line so titles never leak into the stored body.
		const start = chunk.findIndex((line) => /^\s*[\s>#]*(?:[*-]\s*)?(?:\d{1,2}[.)]\s*)?(?:\*\*)?\s*(?:problem|approach|gotcha)\s*:/i.test(line));
		if (start === -1) continue;
		const body = chunk
			.slice(start)
			.map((line, i) => (i === 0 ? cleanFirstLessonLine(line) : line))
			.join("\n")
			.replace(/\n-{3,}\s*$/, "")
			.trim();
		if (body) lessons.push(body);
	}
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const lesson of lessons) {
		const key = lesson.replace(/\s+/g, " ").trim().toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(lesson);
	}
	return unique.slice(0, maxLessons);
}

/** A single source handles all modes so parent code only manages one file. */
export const MEMORY_WORKER_SOURCE = String.raw`#!/usr/bin/env node
// Machine-managed by hummin-memory. Do not edit.
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const LESSON_MAX_WORDS = 120;
const MAX_LESSONS_PER_SESSION = 3;
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

// Distill reply parser ("up to N lessons" shapes), embedded verbatim from
// memory-workers.ts (single implementation; see parseDistilledLessons there).
${parseDistilledLessons}

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
			"You are distilling a coding-agent session into up to " + MAX_LESSONS_PER_SESSION + " distinct reusable lessons.",
			"",
			"Rules:",
			"- Reply with ONLY the lessons, numbered, each in this exact shape:",
			"1. Problem: <what the session was trying to do>",
			"   Approach: <what actually worked>",
			"   Gotcha: <the non-obvious thing a future session would need>",
			"2. Problem: ...",
			"- At most " + MAX_LESSONS_PER_SESSION + " lessons; each lesson max " + LESSON_MAX_WORDS + " words.",
			"- Only genuinely distinct, durable lessons: a single-lesson session replies with one, and quality beats quantity.",
			"- If there is no real lesson worth keeping, reply with exactly: NONE",
			"",
			"Working directory: " + job.cwd,
			"",
			"Session transcript (tail):",
			job.tail || "",
		].join("\n");
		const result = spawnSync("hummin", ["-p", prompt, "--provider", job.provider, "--model", job.modelId, "--thinking", job.thinking || "low"], {
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
		// One reply may carry up to MAX_LESSONS_PER_SESSION lessons; a reply
		// without any parsable lesson shape falls back to the raw output
		// (old single-lesson behavior, so nothing distillable is lost).
		const parsed = parseDistilledLessons(output, MAX_LESSONS_PER_SESSION);
		const toStore = parsed.length > 0 ? parsed : [output];
		// Per-lesson intake gate: drop only the gated-out lessons. A null
		// score (gate unavailable) stores that lesson - fail open per lesson.
		const kept = [];
		for (const lesson of toStore) {
			const intake = await layaIntakeScore(lesson);
			if (intake !== null && intake < INTAKE_THRESHOLD) continue;
			kept.push(lesson);
		}
		if (kept.length === 0) {
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
			for (const lesson of kept) {
				const record = { timestamp: now, cwd: job.cwd, project: job.project, session: job.session, sessionFile: job.sessionFile, lesson: lesson };
				appendFileSync(join(memoryDir, "lessons.jsonl"), JSON.stringify(record) + "\n");
			}
			const markdownPath = join(memoryDir, String(job.project).replace(/[^a-zA-Z0-9._-]/g, "-") + ".lessons.md");
			if (!existsSync(markdownPath)) writeFileSync(markdownPath, "# Lessons - " + job.cwd + "\n\n");
			// One mirror section per lesson keeps the "one record = one section"
			// shape of the human-readable view.
			for (const lesson of kept) appendFileSync(markdownPath, "## " + now + "\n\n" + lesson + "\n\n");
			state.processed = state.processed || {};
			state.processed[job.sessionFile] = now;
			atomicWrite(join(memoryDir, "state.json"), JSON.stringify(state, null, 1));
			boundedLessons(memoryDir);
			if (job.vaultMode && job.vaultDir) {
				const inbox = join(job.vaultDir, "inbox");
				mkdirSync(inbox, { recursive: true });
				const base = "lesson-" + now.replace(/[:.]/g, "-");
				for (const lesson of kept) {
					let inboxPath = join(inbox, base + ".md");
					let suffix = 0;
					while (existsSync(inboxPath)) inboxPath = join(inbox, base + "-" + (++suffix) + ".md");
					writeFileSync(inboxPath, ["---", "type: lesson", "date: " + now.slice(0, 10), "project: " + job.cwd, "session: " + (job.session || "unknown"), "---", "", lesson, ""].join("\n"));
				}
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
		const result = spawnSync("hummin", ["-p", prompt, "--provider", job.provider, "--model", job.modelId, "--thinking", job.thinking || "low"], {
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
