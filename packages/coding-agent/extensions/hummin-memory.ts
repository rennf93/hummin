/**
 * hummin-memory: session distillation (spec 13.2, lesson mode).
 *
 * On session shutdown, the session is queued for distillation into up to three
 * distinct lessons, each in a fixed shape (Problem: / Approach: / Gotcha:, max
 * 120 words). A detached worker makes the one-shot print-mode hummin call and
 * appends each lesson to the project's lessons file, so shutdown never blocks
 * on the model call. If there is no real lesson, the model replies NONE and
 * nothing is stored - the store never fills with junk (RoboCo memory_distiller
 * gate).
 *
 * Idempotency: one distillation pass per session id (yielding up to three
 * lessons); a state file marks processed sessions so a re-shutdown cannot
 * duplicate. Failures are skipped (record nothing rather than storing junk).
 *
 * Config (all optional):
 *   HUMMIN_MEMORY=1            enable (default off - experimental)
 *   HUMMIN_MEMORY_PROVIDER     provider for the no-model-selected fallback of
 *                              fold/distill/expansion calls (default: zai).
 *                              The session's selected model wins when one is
 *                              selected; this only pins the fallback.
 *   HUMMIN_MEMORY_MODEL_ID     model id for the same fallback (default:
 *                              glm-5.3-flash)
 *   HUMMIN_MEMORY_DIR          storage dir (default: <agentDir>/memory)
 *   HUMMIN_MEMORY_MAX_CHARS    transcript tail passed to the distiller (default: 12000)
 *   HUMMIN_MEMORY_QUERY_EXPAND set to 0 (or memoryQueryExpand=false in
 *                              settings) to disable model-assisted query
 *                              expansion in recall and vault search
 *   HUMMIN_MEMORY_AUTO_FOLD_THRESHOLD  inbox lesson count that triggers an
 *                              automatic fold pass (default 3; 0 disables)
 *
 * In vault mode the fold pass also runs automatically: at session start, on
 * agent_end, and after shutdown distillation, whenever the inbox holds at
 * least the threshold number of lessons. Folds run as a detached hummin
 * child (HUMMIN_MEMORY=0) writing to <vault>/fold.log, so neither startup,
 * turns, nor shutdown ever block on the fold.
 *
 * Retrieval: relevance-floored injection that follows the work. The top hits
 * for the current prompt are injected when they contain lessons not yet
 * injected this session (delta injection, so a lesson is never briefed twice
 * into session history), plus a `vault` tool for on-demand search over
 * lessons and vault entities. Every injected or searched lesson is stamped
 * with lastInjectedAt in lessons.jsonl, which the store's decay policy uses
 * to prefer keeping recently used lessons. Lessons are plain JSONL plus a
 * human-readable markdown mirror.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, appendFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { MEMORY_WORKER_SOURCE, type MemoryDistillJob, type MemoryFoldJob } from "./lib/memory-workers.ts";
import { prepareChildDispatch, type DispatchReceipt } from "./lib/child-dispatch-review.ts";

const LESSON_MAX_WORDS = 120;



function agentDir(): string {
	return getAgentDir();
}

function memoryDir(): string {
	return process.env.HUMMIN_MEMORY_DIR ?? join(agentDir(), "memory");
}

function projectKey(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function readTranscriptTail(path: string, maxChars: number): string {
	try {
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		const turns: string[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg || (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "toolResult")) continue;
				const text = (msg.content ?? [])
					.filter((c: { type: string }) => c.type === "text")
					.map((c: { text?: string }) => c.text ?? "")
					.join(" ")
					.trim();
				if (text) turns.push(`${msg.role.toUpperCase()}: ${text}`);
			} catch {
				// skip malformed lines
			}
		}
		return turns.join("\n\n").slice(-maxChars);
	} catch {
		return "";
	}
}

/**
 * Shortest token kept by the recall tokenizer. 3 is the floor: going lower
 * floods queries with stopword-adjacent noise ("of", "to", "is"); 3 keeps
 * real technical terms like "zfs", "api", "git" matchable.
 */
const MIN_TOKEN_LENGTH = 3;

function ensureMemoryWorker(): string {
	mkdirSync(memoryDir(), { recursive: true, mode: 0o700 });
	const file = join(memoryDir(), "memory-worker.mjs");
	try {
		if (readFileSync(file, "utf8") === MEMORY_WORKER_SOURCE) return file;
	} catch {
		// first write
	}
	writeFileSync(file, MEMORY_WORKER_SOURCE, { mode: 0o700 });
	return file;
}

function ensureDistillWorker(): string {
	return ensureMemoryWorker();
}

/** Queue distillation for this session and run it in a detached worker. */
type MemoryDispatchContext = {
	modelRegistry: { getAvailable: () => readonly Model<Api>[] };
	ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
	dispatch?: typeof prepareChildDispatch;
	agentDir?: string;
};

function prepareMemoryDispatch(input: Parameters<typeof prepareChildDispatch>[0], ctx: MemoryDispatchContext): ReturnType<typeof prepareChildDispatch> {
	// Memory distill/fold are background hygiene, so the review wait is held to
	// 1.5s (vs the interactive 4s default) and fails open on timeout.
	return (ctx.dispatch ?? prepareChildDispatch)(input, ctx, { agentDir: ctx.agentDir ?? agentDir(), layaTimeoutMs: 1500 });
}

/** Review-fingerprint prompt for distill dispatches (both fresh and held
 * retries must present the identical prompt or the review store blocks). */
const DISTILL_DISPATCH_PROMPT =
	"Distill the finished coding-agent session transcript into up to three reusable lessons, or return NONE when it contains no durable lesson.";

/** Fields the pending job file carries only while a dispatch hold keeps it
 * from running (declared on MemoryDistillJob in lib/memory-workers.ts). */
type DistillJobFile = MemoryDistillJob;

function spawnDistillWorker(pendingPath: string): void {
	// HUMMIN_MEMORY=0 or the child's own shutdown handler distills again,
	// recursing without bound. The worker's argv is <mode> <job.json>, matching
	// the fold invocation in enqueueFold.
	const child = spawn(process.execPath, [ensureDistillWorker(), "distill", pendingPath], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, HUMMIN_MEMORY: "0" },
	});
	child.unref();
}

function buildDistillJob(sessionFile: string, cwd: string, tail: string, dir: string, pendingPath: string, vaultMode: boolean, dispatch: Awaited<ReturnType<typeof prepareChildDispatch>>): DistillJobFile {
	return {
		mode: "distill",
		memoryDir: dir,
		sessionFile,
		cwd,
		tail,
		provider: dispatch.configuration.provider,
		modelId: dispatch.configuration.modelId,
		thinking: dispatch.configuration.thinking,
		receipt: dispatch.receipt as DispatchReceipt | undefined,
		reviewId: dispatch.reviewId,
		dispatchReason: dispatch.reason,
		pendingPath,
		project: projectKey(cwd),
		session: basename(sessionFile),
		vaultMode,
		vaultDir: vaultDir(cachedSettings),
		gateLog: join(agentDir(), "laya-gate.log"),
	};
}

export async function enqueueDistill(sessionFile: string, cwd: string, vaultMode: boolean, ctx: MemoryDispatchContext): Promise<void> {
	const tail = readTranscriptTail(sessionFile, Number(process.env.HUMMIN_MEMORY_MAX_CHARS ?? 12000));
	if (tail.length < 120) return; // trivial session, nothing to distill

	const dir = memoryDir();
	const requested = memoryModel();
	const dispatch = await prepareMemoryDispatch(
		{
			kind: "memory-distill",
			prompt: DISTILL_DISPATCH_PROMPT,
			cwd,
			model: `${requested.provider}/${requested.modelId}`,
			thinking: "low",
		},
		ctx,
	);
	mkdirSync(join(dir, "pending"), { recursive: true, mode: 0o700 });
	const pendingPath = join(dir, "pending", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	if (dispatch.action === "block") {
		// Held, not dropped: persist the job with a held marker so the next
		// session start retries it once (retryHeldDistills). The hold itself
		// lives in child-dispatch-reviews.json and this notice.
		const job: DistillJobFile = {
			...buildDistillJob(sessionFile, cwd, tail, dir, pendingPath, vaultMode, dispatch),
			held: true,
			heldReason: dispatch.reason ?? "review required",
			heldAt: new Date().toISOString(),
		};
		writeFileSync(pendingPath, JSON.stringify(job), { mode: 0o600 });
		ctx.ui?.notify?.(`memory distillation held for dispatch review ${dispatch.reviewId ?? "unknown"}: ${dispatch.reason ?? "review required"}; queued for one retry at next startup`, "warning");
		return;
	}
	writeFileSync(pendingPath, JSON.stringify(buildDistillJob(sessionFile, cwd, tail, dir, pendingPath, vaultMode, dispatch)), { mode: 0o600 });

	// Prune pending jobs older than 7 days (crashed workers, abandoned jobs).
	try {
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const f of readdirSync(join(dir, "pending"))) {
			const full = join(dir, "pending", f);
			if (f.endsWith(".json") && existsSync(full)) {
				const stat = statSync(full);
				if (stat.mtimeMs < cutoff) unlinkSync(full);
			}
		}
	} catch {
		// pruning is best effort
	}

	spawnDistillWorker(pendingPath);
}

const HELD_DISTILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HELD_DISTILL_MAX_RETRIES = 1;

/**
 * Sweep held distillation jobs: each is retried at most once and only while
 * younger than 24h, then deleted, so holds can never respawn unboundedly. A
 * retry re-presents the original review id, so a review accepted in the
 * meantime allows the dispatch; a still-pending (or pruned) review blocks
 * again and the job is dropped for good. Called once per session startup, so
 * the sweep itself does not loop. Returns the number of jobs re-spawned.
 */
export async function retryHeldDistills(ctx: MemoryDispatchContext): Promise<number> {
	const pendingDir = join(memoryDir(), "pending");
	if (!existsSync(pendingDir)) return 0;
	let retried = 0;
	for (const file of readdirSync(pendingDir)) {
		if (!file.endsWith(".json")) continue;
		const path = join(pendingDir, file);
		let job: DistillJobFile;
		try {
			job = JSON.parse(readFileSync(path, "utf8")) as DistillJobFile;
		} catch {
			continue;
		}
		if (!job.held) continue;
		const drop = (message: string): void => {
			try {
				unlinkSync(path);
			} catch {
				// best effort
			}
			ctx.ui?.notify?.(message, "warning");
		};
		const heldAt = Date.parse(job.heldAt ?? "");
		if (!Number.isFinite(heldAt) || Date.now() - heldAt > HELD_DISTILL_MAX_AGE_MS) {
			drop("memory: dropped distillation held for over 24h (or carrying no hold timestamp)");
			continue;
		}
		if ((job.heldRetries ?? 0) >= HELD_DISTILL_MAX_RETRIES) {
			drop("memory: dropped distillation whose retry was already spent");
			continue;
		}
		const dispatch = await prepareMemoryDispatch(
			{
				kind: "memory-distill",
				prompt: DISTILL_DISPATCH_PROMPT,
				cwd: job.cwd,
				model: job.provider ? `${job.provider}/${job.modelId}` : undefined,
				thinking: "low",
				reviewId: job.reviewId,
			},
			ctx,
		);
		if (dispatch.action === "block") {
			// The one retry is spent: delete the job rather than leaving it to
			// pile up (its review stays resolvable in child-dispatch-reviews).
			drop(`memory distillation retry held again (${dispatch.reason ?? "review required"}); job dropped`);
			continue;
		}
		// Rewrite with the allowed configuration and clear the held marker
		// (undefined fields vanish from the JSON), then run the worker.
		const next: DistillJobFile = {
			...job,
			provider: dispatch.configuration.provider,
			modelId: dispatch.configuration.modelId,
			thinking: dispatch.configuration.thinking,
			receipt: dispatch.receipt as DispatchReceipt | undefined,
			reviewId: dispatch.reviewId,
			dispatchReason: dispatch.reason,
			held: undefined,
			heldReason: undefined,
			heldAt: undefined,
		};
		writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
		spawnDistillWorker(path);
		retried++;
	}
	return retried;
}

function statePath(): string {
	return join(memoryDir(), "state.json");
}

function alreadyProcessed(sessionFile: string): boolean {
	try {
		const state = JSON.parse(readFileSync(statePath(), "utf8"));
		return Boolean(state.processed?.[sessionFile]);
	} catch {
		return false;
	}
}

function markProcessed(sessionFile: string): void {
	try {
		mkdirSync(memoryDir(), { recursive: true });
		let state: { processed?: Record<string, string> } = {};
		try {
			state = JSON.parse(readFileSync(statePath(), "utf8"));
		} catch {
			// fresh state
		}
		state.processed = state.processed ?? {};
		state.processed[sessionFile] = new Date().toISOString();
		// atomic tmp+replace (vexa-bridge pattern)
		writeFileSync(statePath() + ".tmp", JSON.stringify(state, null, 1));
		// rename is atomic on POSIX
		renameSync(statePath() + ".tmp", statePath());
	} catch {
		// fail-open: bookkeeping must never break shutdown
	}
}


// =============================================================================
// Retrieval: relevance-floored lesson injection, once per session (first
// prompt), so the briefing is a single message in session history.
// Automatic briefings use matching lessons from this project only. Explicit
// vault searches may also retrieve other projects with >= 2 keyword overlaps.
// Rank by BM25, then project identity, then recency. No directory bonuses.
// =============================================================================
//
// Scoring (BM25, spec Slice 9): the core relevance score is BM25 (k1=1.5,
// b=0.75) over the lesson+entity corpus gathered in the same retrieval pass.
// The document frequency map is rebuilt per retrieval call: corpora are small
// (hundreds of short docs), and folds run as detached child processes, so
// there is no in-process fold-completion hookpoint to invalidate a cached
// index against - per-call rebuild is the safe default and cheap at this size.
// The exact-phrase bonus and recency bonus remain ADDITIVE boosts on top of
// the BM25 score, so they reorder ties but never drown term relevance.

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.5;
/** BM25 document-length normalization strength. */
export const BM25_B = 0.75;

/** One indexed document: raw term counts plus its token length. */
export interface Bm25Doc {
	termCounts: Map<string, number>;
	length: number;
}

export function bm25Doc(tokens: string[]): Bm25Doc {
	const termCounts = new Map<string, number>();
	for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
	return { termCounts, length: tokens.length };
}

/** Document frequency per term over the corpus (number of docs containing it). */
export function buildDf(docs: Bm25Doc[]): Map<string, number> {
	const df = new Map<string, number>();
	for (const doc of docs) {
		for (const term of doc.termCounts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
	}
	return df;
}

/** Standard BM25 idf (Lucene variant): always positive, even when the term
 * appears in every document (df == docCount gives a small positive floor). */
export function bm25Idf(df: number, docCount: number): number {
	return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

/** Pure BM25 score of one document against the query terms. */
export function bm25Score(
	queryTerms: Iterable<string>,
	doc: Bm25Doc,
	df: Map<string, number>,
	avgLen: number,
	docCount: number,
	k1: number = BM25_K1,
	b: number = BM25_B,
): number {
	if (docCount === 0 || avgLen <= 0 || doc.length === 0) return 0;
	let score = 0;
	for (const term of queryTerms) {
		const tf = doc.termCounts.get(term) ?? 0;
		if (tf === 0) continue;
		const idf = bm25Idf(df.get(term) ?? 0, docCount);
		score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen));
	}
	return score;
}

const RETRIEVAL_MAX_LESSONS = 3;
const RETRIEVAL_MAX_CHARS = 2000;
const CROSS_PROJECT_MIN_OVERLAP = 2;
/** Bonus when the full multi-word query appears contiguously in a lesson. */
const PHRASE_BONUS = 2;
/** Max bonus for newer lessons (linearly decaying over the past year). */
const RECENCY_BONUS_MAX = 1;
const RECENCY_WINDOW_DAYS = 365;
/** Custom message type carrying recall briefings; its details hold the ids of
 * the lessons it injected, which is how sessions remember what was briefed. */
const RECALL_MESSAGE_TYPE = "hummin-memory-recall";

/**
 * Stable identity for a lesson: a short hash of the trimmed body, the same
 * body identity unionLessonRecords uses to dedupe the store against the
 * folded vault. Ids (not bodies) go into recall message details to keep the
 * persisted session small.
 */
export function lessonIdOf(lesson: string): string {
	return createHash("sha256").update(lesson.trim()).digest("hex").slice(0, 16);
}

/** One injectable lesson: body plus its stable id. */
export interface RecallPart {
	id: string;
	lesson: string;
}

/**
 * Pure delta + char-cap selection for recall injection: drop lessons whose id
 * was already injected this session, then pack the rest in rank order,
 * skipping (not stopping at) any single lesson that would overflow the cap.
 */
export function assembleBriefing(lessons: string[], injectedIds: ReadonlySet<string>, maxChars: number): RecallPart[] {
	const parts: RecallPart[] = [];
	let total = 0;
	for (const lesson of lessons) {
		const id = lessonIdOf(lesson);
		if (injectedIds.has(id)) continue;
		if (total + lesson.length + 2 > maxChars) continue;
		total += lesson.length + 2;
		parts.push({ id, lesson });
	}
	return parts;
}

/**
 * Pure: lesson ids already injected this session, read from the details of
 * prior hummin-memory-recall custom messages. Entries persisted by older
 * versions carry no details and contribute nothing (the in-process fallback
 * set covers those while the process lives).
 */
export function injectedIdsFromEntries(entries: ReadonlyArray<{ type?: unknown; customType?: unknown; details?: unknown }>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== RECALL_MESSAGE_TYPE) continue;
		const lessonIds = (entry.details as { lessonIds?: unknown } | undefined)?.lessonIds;
		if (!Array.isArray(lessonIds)) continue;
		for (const id of lessonIds) if (typeof id === "string") ids.add(id);
	}
	return ids;
}

const STOPWORDS = new Set([
	"that", "this", "with", "from", "have", "been", "were", "their", "there",
	"which", "about", "would", "could", "should", "these", "those", "then",
	"than", "them", "they", "when", "what", "your", "will", "into", "also",
	"just", "like", "over", "under", "after", "before", "only", "more",
	"most", "some", "such", "each", "very", "here", "where", "while",
	"problem", "approach", "gotcha", "please", "help", "need", "want", "the", "and", "for", "are", "was",
]);

export function tokenizeList(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((word) => word.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(word));
}

export function tokenize(text: string): Set<string> {
	return new Set(tokenizeList(text));
}

/** Mild, monotonic recency bias: 1 for a fresh lesson, decaying linearly
 * to 0 over the past year. Missing or malformed timestamps score 0. Kept
 * small so it can reorder ties but never drown term relevance. */
function recencyBonus(record: { timestamp?: unknown }, now = Date.now()): number {
	if (typeof record.timestamp !== "string") return 0;
	const then = Date.parse(record.timestamp);
	if (!Number.isFinite(then)) return 0;
	const ageDays = Math.max(0, (now - then) / 86_400_000);
	return Math.max(0, RECENCY_BONUS_MAX * (1 - ageDays / RECENCY_WINDOW_DAYS));
}

/**
 * A single lesson record, normalized from either the lessons.jsonl distillation
 * store or the folded vault's processed/ directory. `lesson` is the lesson
 * body; `cwd`/`project` name the originating repository; `timestamp` is an
 * ISO date string for recency ranking; `fromVault` marks folded lessons so
 * same-project matching can fall back to a repo-basename match. `lastInjectedAt`
 * is the usage stamp written back to lessons.jsonl records when the lesson is
 * briefed or searched (old records and vault files may lack it).
 */
export interface LessonRecord {
	lesson: string;
	cwd: string;
	project: string;
	timestamp?: unknown;
	lastInjectedAt?: unknown;
	fromVault?: boolean;
	/** For vault-processed lessons: the file stem (the slug entities reference
	 * as [[slug]]). Absent for lessons.jsonl records. */
	slug?: string;
}

/** Remove a leading YAML frontmatter block (---\n...\n---) and return the body. */
function stripFrontmatter(text: string): string {
	const trimmed = text.replace(/^\uFEFF/, "");
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(trimmed);
	return m ? trimmed.slice(m[0].length) : trimmed;
}

/** The raw YAML block between the leading --- fences, or null if absent. */
function frontmatterBlock(text: string): string | null {
	const trimmed = text.replace(/^\uFEFF/, "");
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(trimmed);
	return m ? m[1] : null;
}

/** Value of a `key:` line inside the frontmatter block, or undefined. */
function frontmatterValue(block: string | null, key: string): string | undefined {
	if (!block) return undefined;
	const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block);
	return m ? m[1].trim() : undefined;
}

/**
 * Folded lessons live in <vault>/processed/*.md with a `project:` frontmatter
 * that is often a slug (e.g. "hummin-cli-release") rather than the absolute
 * path the distillation store keeps. Match them by repo basename so a lesson
 * folded from the hummin repo still counts as same-project when working in
 * /Users/ren/of/Documents/GitHub/ZZZ/hummin.
 */
function sameProjectFor(record: Pick<LessonRecord, "cwd" | "fromVault">, project: string): boolean {
	if (!record.fromVault) return resolve(record.cwd) === project;
	const field = String(record.cwd).replace(/[^a-z0-9]/gi, "").toLowerCase();
	if (!field) return false;
	const base = basename(project).replace(/[^a-z0-9]/gi, "").toLowerCase();
	if (!base) return false;
	return field.includes(base);
}

/**
 * Load every folded lesson from the vault's processed/ directory into the
 * normalized record shape. The body is the file with its frontmatter stripped,
 * which is exactly the distilled output the distillation worker stored in
 * lessons.jsonl, so the two sources dedupe cleanly by body.
 */
export function loadVaultLessons(vaultDir: string): LessonRecord[] {
	const processed = join(vaultDir, "processed");
	if (!existsSync(processed)) return [];
	const out: LessonRecord[] = [];
	for (const f of readdirSync(processed)) {
		if (!f.endsWith(".md")) continue;
		try {
			const text = readFileSync(join(processed, f), "utf8");
			const project = frontmatterValue(frontmatterBlock(text), "project") || f.replace(/\.md$/, "");
			out.push({
				lesson: stripFrontmatter(text),
				cwd: project,
				project,
				timestamp: frontmatterValue(frontmatterBlock(text), "date"),
				fromVault: true,
				slug: f.replace(/\.md$/, ""),
			});
		} catch {
			// skip unreadable
		}
	}
	return out;
}

/**
 * The retrieval corpus is the union of the distillation store (lessons.jsonl,
 * which holds recent distillations not yet folded) and the folded vault
 * (processed/, which is the complete archive). Dedup by trimmed lesson body so
 * a lesson that was distilled into the store and then folded into the vault is
 * counted once. lessons.jsonl is emitted first so its exact-path project match
 * wins ties.
 */
export function unionLessonRecords(vaultDir?: string): LessonRecord[] {
	const byBody = new Map<string, LessonRecord>();
	const jsonl = join(memoryDir(), "lessons.jsonl");
	if (existsSync(jsonl)) {
		for (const line of readFileSync(jsonl, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line);
				if (typeof r.lesson !== "string" || typeof r.cwd !== "string") continue;
				const body = r.lesson.trim();
				if (!byBody.has(body)) {
					byBody.set(body, {
						lesson: r.lesson,
						cwd: r.cwd,
						project: r.project ?? r.cwd,
						timestamp: r.timestamp,
						lastInjectedAt: r.lastInjectedAt,
					});
				}
			} catch {
				// skip malformed
			}
		}
	}
	if (vaultDir) {
		for (const r of loadVaultLessons(vaultDir)) {
			const body = r.lesson.trim();
			if (!byBody.has(body)) byBody.set(body, r);
		}
	}
	return [...byBody.values()];
}

/**
 * Map lesson slug -> titles of vault entities that reference it via
 * [[wikilink]]. Choice of linkage mechanism for entity recall: the vault
 * contract makes every fold record lesson provenance inside the entity files
 * ("(from [[lesson-slug]], YYYY-MM-DD)"), so the lesson-to-entity edges are
 * cheaply derivable with one scan of entities/ - no fold-output parsing, no
 * index to invalidate. Returns an empty map when no entity references any of
 * the slugs. Slugs are matched lowercase on both sides (lesson file stems
 * carry the ISO timestamp's capital T/Z, wikilinks may not).
 */
function lessonEntityTitles(vaultDir: string, slugs: ReadonlySet<string>): Map<string, string[]> {
	const map = new Map<string, string[]>();
	if (slugs.size === 0) return map;
	const entitiesDir = join(vaultDir, "entities");
	if (!existsSync(entitiesDir)) return map;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			try {
				const title = entry.name.slice(0, -3);
				for (const match of readFileSync(full, "utf8").matchAll(/\[\[([^\]|#]+)/g)) {
					const target = match[1].trim().toLowerCase();
					if (!slugs.has(target)) continue;
					const titles = map.get(target) ?? [];
					if (!titles.includes(title)) titles.push(title);
					map.set(target, titles);
				}
			} catch {
				// skip unreadable
			}
		}
	};
	walk(entitiesDir);
	return map;
}

/** Entity titles as extra BM25 terms: the kebab slug itself plus its
 * hyphen-split words, so "build-cache" matches both spellings. */
function entityTitleTerms(title: string): string[] {
	return [...tokenizeList(title), ...tokenizeList(title.replace(/[-_]+/g, " "))];
}

export function recallLessons(
	cwd: string,
	query: string,
	limit = RETRIEVAL_MAX_LESSONS,
	scope: "project" | "all" = "project",
	extraTerms: readonly string[] = [],
): string[] {
	const queryTerms = tokenize(query);
	for (const term of tokenizeList(extraTerms.join(" "))) queryTerms.add(term);
	if (queryTerms.size === 0) return [];
	const project = resolve(cwd);
	const dir = vaultDir(cachedSettings);
	// Pass 1: parse and index every lesson into the BM25 corpus. The corpus is
	// the union of the distillation store and the folded vault, so lessons that
	// were folded out of lessons.jsonl into processed/ stay retrievable.
	const allRecords = unionLessonRecords(dir);
	// Entity-linkage augmentation: fold the titles of entities that cite a
	// vault lesson ([[slug]] wikilinks, see lessonEntityTitles) into that
	// lesson's BM25 terms. A paraphrase query can then reach the lesson through
	// its entity names, and the extra terms also count toward the relevance
	// floor below. Applied at index time only; stored lesson bodies are never
	// rewritten, so dedup and briefing output stay byte-identical.
	const slugs = new Set(
		allRecords.flatMap((r) => (typeof r.slug === "string" ? [r.slug.toLowerCase()] : [])),
	);
	const linkedEntities = lessonEntityTitles(dir, slugs);
	const records: { lesson: string; doc: Bm25Doc; sameProject: boolean; timestamp?: unknown; index: number }[] = [];
	let index = 0;
	for (const record of allRecords) {
		index++;
		const augment = record.slug ? (linkedEntities.get(record.slug.toLowerCase()) ?? []).flatMap(entityTitleTerms) : [];
		records.push({
			lesson: record.lesson,
			doc: bm25Doc([...tokenizeList(record.lesson), ...augment]),
			sameProject: sameProjectFor(record, project),
			timestamp: record.timestamp,
			index,
		});
	}
	if (records.length === 0) return [];
	// Pass 2: BM25 relevance over the corpus, with phrase/recency as additive boosts.
	const df = buildDf(records.map((r) => r.doc));
	const avgLen = records.reduce((sum, r) => sum + r.doc.length, 0) / records.length;
	const lowerQuery = query.trim().toLowerCase();
	const scored: { lesson: string; score: number; sameProject: boolean; index: number }[] = [];
	for (const record of records) {
		// Relevance floor: project lessons need at least one query term;
		// cross-project lessons need CROSS_PROJECT_MIN_OVERLAP distinct terms.
		const matched = [...queryTerms].filter((term) => record.doc.termCounts.has(term)).length;
		if (record.sameProject ? matched === 0 : scope !== "all" || matched < CROSS_PROJECT_MIN_OVERLAP) continue;
		const lowerLesson = record.lesson.toLowerCase();
		const phrase = lowerQuery.includes(" ") && lowerLesson.includes(lowerQuery) ? PHRASE_BONUS : 0;
		const score = bm25Score(queryTerms, record.doc, df, avgLen, records.length) + phrase + recencyBonus({ timestamp: record.timestamp });
		scored.push({ lesson: record.lesson, score, sameProject: record.sameProject, index: record.index });
	}
	scored.sort((a, b) => b.score - a.score || Number(b.sameProject) - Number(a.sameProject) || b.index - a.index);
	return scored.slice(0, limit).map((entry) => entry.lesson);
}

/**
 * Compact lesson briefing for child sessions (imported by other extensions,
 * e.g. the subagent dispatcher, as `import { lessonsForChildBrief } from
 * "./hummin-memory.ts"`). Plain lexical BM25 over the union lesson corpus with
 * the task prompt as query: no model call, no query expansion, project scope
 * only (same-project bias). Returns null when memory is disabled or nothing
 * matches. Safe against circular imports: this module imports no other
 * extension entry point.
 *
 * Side-effect contract: lastInjectedAt is NOT stamped. A child briefing is
 * advisory, not a session injection, so it must not count as use in the
 * store's usage-aware decay; only session briefings and explicit vault
 * searches stamp the store.
 *
 * The block carries no cwd/date context lines: lesson bodies already embed
 * their context, and the char budget is better spent on content.
 */
export async function lessonsForChildBrief(query: string, maxChars = 1200): Promise<string | null> {
	const enabled = cachedSettings ? cachedSettings.getMemoryEnabled() : process.env.HUMMIN_MEMORY === "1";
	if (!enabled) return null;
	const trimmed = query.trim();
	if (!trimmed) return null;
	const lessons = recallLessons(process.cwd(), trimmed, 2);
	if (lessons.length === 0) return null;
	const header = "Relevant lessons from prior work:";
	const lines: string[] = [];
	let total = header.length;
	for (const lesson of lessons) {
		if (total + lesson.length + 3 > maxChars) {
			// Prefer a truncated first lesson over returning nothing.
			if (lines.length === 0) {
				const budget = Math.max(0, maxChars - header.length - 8);
				lines.push(`- ${lesson.slice(0, budget)}...`);
			}
			break;
		}
		lines.push(`- ${lesson}`);
		total += lesson.length + 3;
	}
	if (lines.length === 0) return null;
	return `${header}\n${lines.join("\n")}`;
}

/**
 * On-demand search for the `vault` tool: project lessons (cross-project
 * included by the relevance floor) plus vault entity files, both scored by
 * plain term overlap. The query is expanded first (one cheap model call,
 * fail-open, see expandQueryTerms) unless the whole corpus is empty - nothing
 * can match either way, so fresh installs pay zero latency. Returns a short
 * briefing string, capped.
 */
export async function searchVault(query: string, cwd: string): Promise<string> {
	const sections: string[] = [];
	const dir = vaultDir(cachedSettings);
	const hasCorpus = unionLessonRecords(dir).length > 0 || countVaultEntities(dir) > 0;
	const extra = hasCorpus ? await expandQueryTerms(query) : [];
	const lessons = recallLessons(cwd, query, 5, "all", extra);
	// Every search result counts as a use: stamp it so decay keeps lessons the
	// agent actually consults.
	markLessonsInjected(lessons);
	if (lessons.length > 0) {
		sections.push(`Lessons (${lessons.length}):\n${lessons.join("\n\n")}`);
	}
	const entities = searchEntities(query, 3);
	if (entities.length > 0) {
		sections.push(`Vault entities:\n${entities.join("\n")}`);
	}
	if (sections.length === 0) sections.push(`no lessons or entities match "${query}".`);
	// Header names the vault actually searched: HUMMIN_MEMORY_VAULT_DIR can
	// point sessions at a different vault than the default dir, and raw file
	// inspection of the default dir has produced duplicate graphs before.
	return `vault: ${dir} · ${countVaultEntities(dir)} entities · ${countVaultLessons()} lessons\n\n${sections.join("\n\n")}`.slice(0, 4200);
}

function countVaultEntities(dir: string): number {
	const entitiesDir = join(dir, "entities");
	if (!existsSync(entitiesDir)) return 0;
	let count = 0;
	const walk = (d: string): void => {
		for (const f of readdirSync(d)) {
			const full = join(d, f);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(full);
			else if (f.endsWith(".md")) count++;
		}
	};
	walk(entitiesDir);
	return count;
}

function countVaultLessons(): number {
	// Count the retrieval corpus: the union of lessons.jsonl and the folded
	// vault. Counting the store alone understated the vault (it only held
	// distillations not yet folded, so folding silently shrank the report).
	return unionLessonRecords(vaultDir(cachedSettings)).length;
}

/**
 * One-time (or on-demand) corpus rebuild: append any folded vault lessons that
 * are missing from lessons.jsonl so the distillation store matches the vault.
 * Existing lines keep their order; only genuinely missing vault lessons are
 * appended. Dedup by trimmed lesson body, which is identical across both
 * sources (the vault body is the distilled output with frontmatter prepended).
 */
export function rebuildLessonsFromVault(): { added: number; total: number } {
	const target = join(memoryDir(), "lessons.jsonl");
	const seen = new Map<string, string>();
	if (existsSync(target)) {
		for (const line of readFileSync(target, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line);
				if (typeof r.lesson === "string") seen.set(r.lesson.trim(), JSON.stringify(r));
			} catch {
				// drop the malformed line instead of carrying it forward
			}
		}
	}
	let added = 0;
	for (const r of loadVaultLessons(vaultDir(cachedSettings))) {
		const body = r.lesson.trim();
		if (!seen.has(body)) {
			const slug = String(r.project).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "lesson";
			seen.set(body, JSON.stringify({
				timestamp: r.timestamp ?? new Date().toISOString(),
				cwd: r.cwd,
				project: r.project,
				session: slug,
				sessionFile: slug,
				lesson: r.lesson,
			}));
			added++;
		}
	}
	const text = [...seen.values()].join("\n") + "\n";
	writeFileSync(target + ".tmp", text);
	// rename is atomic on POSIX; a crash leaves the original lessons.jsonl intact.
	renameSync(target + ".tmp", target);
	return { added, total: seen.size };
}

/**
 * Pure: one lessons.jsonl line re-stamped with lastInjectedAt when its lesson
 * body is in `bodies`, otherwise returned unchanged. Malformed lines and
 * non-lesson lines pass through byte-identical, and the round-trip of a
 * record that already carries the stamp is the identical string, so callers
 * can detect "nothing changed" by line equality.
 */
export function stampLessonLine(line: string, bodies: ReadonlySet<string>, now: string): string {
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line);
	} catch {
		return line;
	}
	if (typeof record.lesson !== "string" || !bodies.has(record.lesson.trim())) return line;
	return JSON.stringify({ ...record, lastInjectedAt: now });
}

/**
 * Stamp lastInjectedAt on the lessons.jsonl records matching these lesson
 * bodies. Used for usage-aware decay: the store's drop policy prefers keeping
 * recently injected lessons. Cheap (one read; the atomic rewrite happens only
 * when at least one record changed) and fail-open - usage tracking must never
 * break recall or search. Vault-processed lessons are archived markdown and
 * are deliberately not stamped.
 */
export function markLessonsInjected(bodies: string[], now = new Date().toISOString()): void {
	if (bodies.length === 0) return;
	const target = join(memoryDir(), "lessons.jsonl");
	if (!existsSync(target)) return;
	const wanted = new Set(bodies.map((body) => body.trim()));
	try {
		const lines = readFileSync(target, "utf8").split("\n");
		let changed = false;
		const next = lines.map((line) => {
			if (!line.trim()) return line;
			const stamped = stampLessonLine(line, wanted, now);
			if (stamped !== line) changed = true;
			return stamped;
		});
		if (!changed) return;
		writeFileSync(target + ".tmp", next.join("\n"));
		renameSync(target + ".tmp", target);
	} catch {
		// fail-open: usage tracking is best effort
	}
}

function searchEntities(query: string, limit: number): string[] {
	const dir = vaultDir(cachedSettings);
	const entitiesDir = join(dir, "entities");
	if (!existsSync(entitiesDir)) return [];
	const queryTerms = tokenize(query);
	if (queryTerms.size === 0) return [];
	const scored: { rel: string; score: number; matched: number; hits: string[] }[] = [];
	const docs: { rel: string; doc: Bm25Doc; hits: string[] }[] = [];
	const walk = (d: string): void => {
		for (const f of readdirSync(d)) {
			const full = join(d, f);
			try {
				if (full.endsWith(".md")) {
					const content = readFileSync(full, "utf8");
					const hits = content
						.split("\n")
						.filter((l) => {
							const ll = l.toLowerCase();
							return [...queryTerms].some((t) => ll.includes(t)) && l.trim().length > 0;
						})
						.slice(0, 2);
					docs.push({ rel: full.slice(dir.length + 1), doc: bm25Doc(tokenizeList(content)), hits });
				} else {
					walk(full);
				}
			} catch {
				// skip unreadable
			}
		}
	};
	walk(entitiesDir);
	if (docs.length === 0) return [];
	const df = buildDf(docs.map((d) => d.doc));
	const avgLen = docs.reduce((sum, d) => sum + d.doc.length, 0) / docs.length;
	for (const entry of docs) {
		const score = bm25Score(queryTerms, entry.doc, df, avgLen, docs.length);
		if (score === 0) continue;
		const matched = [...queryTerms].filter((t) => entry.doc.termCounts.has(t)).length;
		scored.push({ rel: entry.rel, score, matched, hits: entry.hits });
	}
	scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
	return scored
		.slice(0, limit)
		.map((e) => `- ${e.rel} (${e.matched} term overlap)\n  ${e.hits.map((h) => h.trim()).join("\n  ")}`);
}

/** Write a user quick-capture note, choosing a suffix if the timestamp repeats. */
export function writeQuickCapture(vault: string, cwd: string, text: string, now = new Date()): string {
	const inbox = join(vault, "inbox");
	mkdirSync(inbox, { recursive: true });
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const body = `---\ntype: note\ndate: ${JSON.stringify(now.toISOString())}\nproject: ${JSON.stringify(cwd)}\n---\n\n${text}\n`;
	for (let suffix = 0; ; suffix++) {
		const filename = `note-${stamp}${suffix === 0 ? "" : `-${suffix}`}.md`;
		const path = join(inbox, filename);
		try {
			writeFileSync(path, body, { flag: "wx" });
			return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

function countMarkdownFiles(dir: string): number {
	if (!existsSync(dir)) return 0;
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) count += countMarkdownFiles(path);
		else if (entry.isFile() && entry.name.endsWith(".md")) count++;
	}
	return count;
}

export interface MemoryDashboard {
	enabled: boolean;
	mode: string;
	vault: string;
	entities: Record<string, number>;
	inbox: number;
	processed: number;
	log: string[];
}

export function getMemoryDashboard(settings: SettingsManager | undefined = cachedSettings): MemoryDashboard {
	const dir = vaultDir(settings);
	const entities: Record<string, number> = {};
	for (const type of ["project", "concept", "decision", "gotcha", "tool", "person"]) {
		entities[type] = countMarkdownFiles(join(dir, "entities", type));
	}
	let log: string[] = [];
	try {
		log = readFileSync(join(dir, "log.md"), "utf8").split("\n").filter((line) => line.startsWith("- ")).slice(-3).reverse();
	} catch {
		// A missing log is an empty vault, not an error.
	}
	return {
		enabled: settings?.getMemoryEnabled() ?? process.env.HUMMIN_MEMORY === "1",
		mode: settings?.getMemoryMode() ?? process.env.HUMMIN_MEMORY_MODE ?? "lessons",
		vault: dir,
		entities,
		inbox: countMarkdownFiles(join(dir, "inbox")),
		processed: countMarkdownFiles(join(dir, "processed")),
		log,
	};
}

function dashboardText(dashboard: MemoryDashboard): string {
	const entityCount = Object.values(dashboard.entities).reduce((sum, count) => sum + count, 0);
	const byType = Object.entries(dashboard.entities).filter(([, count]) => count > 0).map(([type, count]) => `${type} ${count}`).join(", ") || "none";
	const recent = dashboard.log.length > 0 ? `\nRecent folds:\n${dashboard.log.join("\n")}` : "";
	return `memory: ${dashboard.enabled ? "on" : "off"} (${dashboard.mode})\nvault: ${dashboard.vault}\nentities: ${entityCount} (${byType})\ninbox: ${dashboard.inbox} | processed: ${dashboard.processed}${recent}`;
}

let cachedSettings: SettingsManager | undefined; // set by the extension's default export (real runs only; tests leave it undefined)

/** The model the user is running (updated on model_select). Memory fold and
 * distillation calls follow it, so the vault is managed by the same
 * provider/model as the session; the zai/glm-5.3-flash defaults are the
 * fallback when no model is selected yet (and the env vars can pin either). */
let sessionModel: Model<Api> | undefined;

function memoryModel(): { provider: string; modelId: string } {
	if (sessionModel) return { provider: sessionModel.provider, modelId: sessionModel.id };
	return {
		provider: cachedSettings?.getMemoryProvider() ?? "zai",
		modelId: cachedSettings?.getMemoryModelId() ?? "glm-5.3-flash",
	};
}

// =============================================================================
// Query expansion (retrieval quality): one cheap print-mode call that turns a
// prompt into extra search keywords, so paraphrase queries still hit lessons
// written with different vocabulary. Purely additive: the extra terms are
// unioned into the BM25 query terms; the raw query keeps driving the phrase
// bonus and the relevance floor still applies. Used by the auto-briefing path
// and the vault tool; lessonsForChildBrief deliberately does NOT expand (it
// must stay model-free).
// =============================================================================

const QUERY_EXPAND_TIMEOUT_MS = 2000;
const QUERY_EXPAND_MAX_KEYWORDS = 8;
/** Upper bound so a long-lived process cannot grow the cache unbounded. */
const QUERY_EXPAND_CACHE_MAX = 200;
const QUERY_EXPANSION_PROMPT =
	"Return up to 8 extra lowercase search keywords (comma-separated, keywords only, no explanations, no numbering) that would help retrieve prior lessons and notes about the following task: ";

interface QueryExpandSettings {
	memoryQueryExpand?: unknown;
}

/** Env gate first (HUMMIN_MEMORY_QUERY_EXPAND=0/false/off), then the settings
 * key memoryQueryExpand=false (project settings override global). Default on. */
function queryExpansionEnabled(): boolean {
	const env = process.env.HUMMIN_MEMORY_QUERY_EXPAND?.trim();
	if (env && /^(0|false|off)$/i.test(env)) return false;
	if (!cachedSettings) return true;
	try {
		const global = cachedSettings.getGlobalSettings() as QueryExpandSettings;
		const project = cachedSettings.getProjectSettings() as QueryExpandSettings;
		return { ...global, ...project }.memoryQueryExpand !== false;
	} catch {
		return true;
	}
}

/** One print-mode hummin call; resolves "" on any failure including timeout
 * (execFile kills the child and errors). HUMMIN_MEMORY=0 in the child env:
 * the child's own shutdown handler must never distill again. */
function runMemoryPrint(prompt: string, provider: string, modelId: string, thinking: string, timeoutMs: number): Promise<string> {
	return new Promise((resolvePrint) => {
		execFile(
			"hummin",
			["-p", prompt, "--provider", provider, "--model", modelId, "--thinking", thinking],
			{ timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...process.env, HUMMIN_MEMORY: "0" } },
			(error, stdout) => resolvePrint(error ? "" : String(stdout)),
		);
	});
}

/** Pure: keyword list from raw model output. Comma- or whitespace-separated,
 * single tokens only (3-30 chars of [a-z0-9_./-]), deduped, capped. Models
 * ignore the comma instruction often enough that space separation must parse. */
export function parseExpansionKeywords(output: string): string[] {
	const seen = new Set<string>();
	for (const raw of output.split(/[\s,]+/)) {
		const keyword = raw.trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9_./-]{2,29}$/.test(keyword)) continue;
		seen.add(keyword);
	}
	return [...seen].slice(0, QUERY_EXPAND_MAX_KEYWORDS);
}

const queryExpansionCache = new Map<string, string[]>();

/**
 * Extra retrieval keywords for a query, via one cheap memoryModel() call
 * (thinking low). Fail-open to [] when disabled by gate, on timeout or error,
 * or when the reply parses to nothing. Only successful expansions are cached,
 * per query, for process lifetime: a transient failure should get another
 * chance rather than permanently downgrade that query's retrieval.
 */
export async function expandQueryTerms(query: string): Promise<string[]> {
	const trimmed = query.trim();
	if (!trimmed || tokenize(trimmed).size === 0) return [];
	if (!queryExpansionEnabled()) return [];
	const cached = queryExpansionCache.get(trimmed);
	if (cached) return cached;
	const requested = memoryModel();
	const output = await runMemoryPrint(QUERY_EXPANSION_PROMPT + trimmed, requested.provider, requested.modelId, "low", QUERY_EXPAND_TIMEOUT_MS);
	const terms = parseExpansionKeywords(output);
	if (terms.length === 0) return [];
	if (queryExpansionCache.size >= QUERY_EXPAND_CACHE_MAX) {
		const oldest = queryExpansionCache.keys().next();
		if (!oldest.done) queryExpansionCache.delete(oldest.value);
	}
	queryExpansionCache.set(trimmed, terms);
	return terms;
}

export default function humminMemory(pi: ExtensionAPI): void {
	const settings = SettingsManager.create(process.cwd());
	cachedSettings = settings;
	pi.registerCommand("memory", {
		description: "Show memory and vault status",
		category: "Memory/Vault",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(dashboardText(getMemoryDashboard(settings)), "info");
			} catch (error) {
				ctx.ui.notify(`memory: unable to read dashboard (${error instanceof Error ? error.message : String(error)})`, "error");
			}
		},
	});
	if (!settings.getMemoryEnabled()) return;

	pi.on("model_select", (event) => {
		sessionModel = event.model;
	});

	// Held distillation sweep: once per real startup (not reload/resume/fork,
	// where the shutdown that follows would re-enqueue anyway). Fail-open.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		try {
			await retryHeldDistills(ctx);
		} catch {
			// fail-open: a held-job retry must never break startup
		}
	});

	pi.registerTool({
		name: "vault",
		label: "Vault Search",
		description:
			"Search hummin's memory vault and all project lessons for prior work: decisions, gotchas, concepts, tool notes. Run this before starting work on any feature - new or old - to be up to date with the latest lessons and vault state.",
		promptSnippet: "vault: search lessons and vault entities before starting work on a feature",
		parameters: Type.Object({
			query: Type.String({ description: "What to recall, e.g. the feature or area you are about to work on" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) return { content: [{ type: "text" as const, text: "Error: empty query" }], details: {}, isError: true };
			return { content: [{ type: "text" as const, text: await searchVault(query, ctx.cwd) }], details: {} };
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith("# ")) return { action: "continue" as const };
		if (!settings.getMemoryEnabled()) return { action: "continue" as const };
		try {
			const path = writeQuickCapture(settings.getMemoryVaultDir(), ctx.cwd, event.text.slice(2));
			ctx.ui.notify(`captured to vault inbox: ${path}`, "info");
		} catch (error) {
			ctx.ui.notify(`memory: quick capture failed (${error instanceof Error ? error.message : String(error)})`, "error");
		}
		return { action: "handled" as const };
	});

	if (settings.getMemoryMode() === "vault") {
		ensureVault();
		pi.registerCommand("vault-fold", {
			description: "Fold inbox lessons into the vault entity graph",
			category: "Memory/Vault",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(await vaultFold("command", ctx), "info");
				} catch (error) {
					ctx.ui.notify(`vault: fold failed (${error instanceof Error ? error.message : String(error)})`, "error");
				}
			},
		});

		// Automatic folds: pending lessons fold in the background once they
		// reach the threshold, checked at session start and after each turn.
		let foldCheckedAtStart = false;
		pi.on("before_agent_start", async (_event, ctx) => {
			if (foldCheckedAtStart) return;
			foldCheckedAtStart = true;
			const dir = ensureVault();
			const pending = inboxLessonCount(dir);
			if (pending > 0 && ctx?.ui?.notify) {
				ctx.ui.notify(`vault: ${pending} lesson(s) waiting to fold`, "info");
			}
			void triggerAutoFold(dir, "session start", ctx);
		});
		pi.on("agent_end", async (_event, ctx) => {
			await triggerAutoFold(ensureVault(), "agent_end", ctx);
		});
		pi.registerCommand("vault-canvas", {
			description: "Render the vault entity graph as graph.canvas",
			category: "Memory/Vault",
			handler: async (_args, ctx) => {
				const dir = ensureVault();
				const count = writeCanvas(dir);
				ctx.ui.notify(
					count > 0 ? `vault: graph.canvas written (${count} entities)` : "vault: no entities to draw yet",
					count > 0 ? "info" : "warning",
				);
			},
		});
		pi.registerCommand("vault-recall", {
			description: "Search vault entities",
			category: "Memory/Vault",
			handler: async (args, ctx) => {
				const query = (args ?? "").trim().toLowerCase();
				if (!query) {
					ctx.ui.notify("usage: /vault-recall <query>", "warning");
					return;
				}
				const matches: string[] = [];
				const entitiesDir = join(vaultDir(cachedSettings), "entities");
				const walk = (dir: string) => {
					for (const f of readdirSync(dir)) {
						const full = join(dir, f);
						if (!existsSync(full)) continue;
						try {
							if (full.endsWith(".md")) {
								const content = readFileSync(full, "utf8");
								if (content.toLowerCase().includes(query)) {
									const hits = content.split("\n").filter((l) => l.toLowerCase().includes(query)).slice(0, 3);
									matches.push(`${full.replace(vaultDir(cachedSettings) + "/", "")}\n  ${hits.join("\n  ")}`);
								}
							} else {
								walk(full);
							}
						} catch {
							// skip unreadable
						}
					}
				};
				walk(entitiesDir);
				ctx.ui.notify(matches.length ? `vault: ${matches.length} file(s) matching "${query}"\n\n${matches.join("\n\n")}` : `vault: no matches for "${query}"`, "info");
			},
		});
	}

	// Recall that follows the work: every prompt's top hits are injected when
	// they contain lessons not yet injected this session. The injected set is
	// derived from the persisted recall messages' details (survives reloads,
	// resumed sessions, and tree navigation) plus a per-process fallback set
	// for entries persisted without details. When nothing in the top-k is new,
	// nothing is injected - later retrieval stays explicit through the vault
	// tool. Non-command prompts only: command text is UI, not work to recall.
	const injectedBySession = new Map<string, Set<string>>();

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = event.prompt.trim();
		if (prompt.startsWith("/")) return undefined;
		// Empty corpus: nothing can match, skip both the expansion call and the
		// ranking pass so the first prompt of a fresh install stays instant.
		if (unionLessonRecords(vaultDir(cachedSettings)).length === 0) return undefined;
		// Expand before ranking: one cheap model call, fail-open to the raw
		// query (see expandQueryTerms).
		const extra = await expandQueryTerms(prompt);
		const lessons = recallLessons(ctx.cwd, prompt, RETRIEVAL_MAX_LESSONS, "project", extra);
		if (lessons.length === 0) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const injected = injectedIdsFromEntries(ctx.sessionManager.getEntries());
		const fallback = injectedBySession.get(sessionId);
		if (fallback) for (const id of fallback) injected.add(id);
		const parts = assembleBriefing(lessons, injected, RETRIEVAL_MAX_CHARS);
		if (parts.length === 0) return undefined;
		if (!injectedBySession.has(sessionId)) injectedBySession.set(sessionId, new Set());
		for (const part of parts) injectedBySession.get(sessionId)!.add(part.id);
		// Stamp the store so usage-aware decay keeps these lessons.
		markLessonsInjected(parts.map((part) => part.lesson));
		if (ctx?.ui?.notify) {
			ctx.ui.notify(`memory: ${parts.length} project lesson(s) applied to this session`, "info");
		}
		return {
			message: {
				customType: RECALL_MESSAGE_TYPE,
				content: [{ type: "text", text: `Project memory (${parts.length} recent lesson(s) for this project):\n\n${parts.map((part) => part.lesson).join("\n\n")}` }] satisfies TextContent[],
				display: false,
				details: { lessonIds: parts.map((part) => part.id) },
			},
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload") return;
		try {
			const cwd = ctx.cwd;
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || alreadyProcessed(sessionFile)) return;
			// Distillation runs in a detached worker; shutdown never blocks on
			// the model call (fail-open: memory must never break shutdown). The
			// dispatch review before it adds a bounded, fail-open wait of at
			// most ~1.5s (prepareMemoryDispatch's layaTimeoutMs).
			await enqueueDistill(sessionFile, cwd, settings.getMemoryMode() === "vault", ctx);
		} catch {
			// fail-open: memory must never block shutdown
		}
	});
}

// =============================================================================
// Vault mode (HUMMIN_MEMORY_MODE=vault): a git-backed, Obsidian-compatible
// knowledge graph that the agent itself maintains. Lessons land in inbox/,
// a fold pass (on demand via /vault-fold) runs a hummin session with the
// vault as cwd - so the vault's AGENTS.md conventions contract is its system
// context - and the agent folds lessons into entities, updates log.md, and
// commits. The git repo is the source of truth (vexa-bridge pattern).
// =============================================================================

/**
 * Enqueue a fold job and run it as a detached memory worker (shared "fold"
 * mode: atomic lock in the vault, output appended to <vault>/fold.log). The
 * caller returns immediately; neither the command handler nor a turn blocks
 * on the model call. HUMMIN_MEMORY=0 in the child env or its shutdown
 * handler distills again, recursing without bound.
 */
export async function enqueueFold(dir: string, label: string, ctx: MemoryDispatchContext): Promise<boolean> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const jobPath = join(dir, ".fold-job.json");
	const requested = memoryModel();
	const dispatch = await prepareMemoryDispatch(
		{
			kind: "memory-fold",
			prompt: "Fold the inbox lessons into the entity graph now, following AGENTS.md exactly.",
			cwd: dir,
			model: `${requested.provider}/${requested.modelId}`,
			thinking: "low",
		},
		ctx,
	);
	const job: MemoryFoldJob = {
		mode: "fold",
		vaultDir: dir,
		provider: dispatch.configuration.provider,
		modelId: dispatch.configuration.modelId,
		thinking: dispatch.configuration.thinking,
		receipt: dispatch.receipt as DispatchReceipt | undefined,
		reviewId: dispatch.reviewId,
		dispatchReason: dispatch.reason,
		threshold: 1,
		force: true,
		label,
		pendingPath: jobPath,
	};
	writeFileSync(jobPath, JSON.stringify(job, null, 1), { mode: 0o600 });
	if (dispatch.action === "block") {
		ctx.ui?.notify?.(`memory fold held for dispatch review ${dispatch.reviewId ?? "unknown"}: ${dispatch.reason ?? "review required"}`, "warning");
		return false;
	}
	const child = spawn(process.execPath, [ensureMemoryWorker(), "fold", jobPath], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, HUMMIN_MEMORY: "0" },
	});
	child.unref();
	return true;
}

async function vaultFold(label: string, ctx: MemoryDispatchContext): Promise<string> {
	const dir = ensureVault();
	const inboxCount = inboxLessonCount(dir);
	if (inboxCount === 0) return "vault: inbox is empty, nothing to fold";
	const started = await enqueueFold(dir, label, ctx);
	return started
		? `vault: folding ${inboxCount} lesson(s) in background (${label}); progress in ${join(dir, "fold.log")}`
		: (() => {
			try {
				const pending = JSON.parse(readFileSync(join(dir, ".fold-job.json"), "utf8")) as { reviewId?: string; dispatchReason?: string };
				return `vault: fold held for dispatch review ${pending.reviewId ?? "unknown"}: ${pending.dispatchReason ?? "review required"}; pending job retained in ${join(dir, ".fold-job.json")}`;
			} catch {
				return `vault: fold held for dispatch review; pending job retained in ${join(dir, ".fold-job.json")}`;
			}
		})();
}

function vaultDir(settings: SettingsManager | undefined): string {
	if (settings) return settings.getMemoryVaultDir();
	const env = process.env.HUMMIN_MEMORY_VAULT_DIR;
	if (env && env.trim().length > 0) return env;
	return join(getAgentDir(), "vault");
}

function vaultContract(): string {
	return `# Vault conventions

This vault is the persistent memory of hummin coding sessions. You are the
curator. Rules:

- Entity files live at entities/<type>/<slug>.md with type one of:
  project, concept, decision, gotcha, tool, person.
- Slug is kebab-case. Reference entities anywhere in the vault as [[slug]].
- Every entity file starts with YAML properties (frontmatter) that Obsidian
  reads: type, created (YYYY-MM-DD), and tags (e.g. tags: [gotcha, zfs]).
- Facts inside entities are dated and attributed: (from [[lesson-slug]], YYYY-MM-DD).
- Gotcha entities open with an Obsidian callout one line long:
  > [!warning] <one-sentence summary>
- Before creating an entity, search all of entities/ (every type dir) for a
  file covering the same topic; extend it instead of creating a parallel
  entity, even if the existing one came from an earlier fold pass. Never
  invent facts that are not in an inbox lesson.
- When an inbox lesson contradicts another lesson or an existing entity fact,
  merge the conflicting sources into one surviving entity, keep the resolution
  the newer lesson supports, and record it as a dated fact in both entities
  ("resolved <topic>: <decision>, from [[lesson-slug]], YYYY-MM-DD").
- After folding, list entities/ and verify every [[link]] you wrote resolves
  to an existing file and that no two entities cover the same topic.
- One project entity per repository is the graph's hub (e.g. project/hummin);
  every other entity links to it directly or through its topic entities. A
  second project entity is only for a distinct deliverable and must link to
  the hub. Never let unanchored entities accumulate.
- Each entity ends with a "## Links" section listing related [[entities]].
  Link notes inside the vault with [[wikilinks]]; keep [text](url) for
  external URLs only.
- Keep entity files short: one overview paragraph, then dated bullet facts.
- Never use em-dashes or en-dashes; use a hyphen, comma, or parentheses.

## Fold procedure

1. Read every file in inbox/.
2. For each lesson: extract entities (projects, concepts, decisions, gotchas,
   tools), create or extend their entity files, and reference the lesson as
   [[<lesson-slug>]] where slug is the lesson filename without extension.
3. Move folded lessons from inbox/ to processed/ (keep filenames).
4. Append one line per folded lesson to log.md: "- <date> folded <lesson-slug>".
5. Stage and commit everything: git add -A && git commit -m "fold: <N> lessons".
Do not skip the commit. Do not touch anything outside the vault.`;
}

export function ensureVault(settings?: SettingsManager): string {
	const dir = vaultDir(settings ?? cachedSettings);
	for (const sub of ["inbox", "processed", join("entities", "project"), join("entities", "concept"), join("entities", "decision"), join("entities", "gotcha"), join("entities", "tool"), join("entities", "person")]) {
		mkdirSync(join(dir, sub), { recursive: true });
	}
	// The contract is machine-managed (it is the feature's spec, not user
	// content), so existing vaults pick up conventions updates on the next
	// fold instead of staying frozen at the version that created them.
	if (!existsSync(join(dir, "AGENTS.md")) || readFileSync(join(dir, "AGENTS.md"), "utf8") !== vaultContract()) {
		writeFileSync(join(dir, "AGENTS.md"), vaultContract());
	}
	if (!existsSync(join(dir, "log.md"))) writeFileSync(join(dir, "log.md"), "# Fold log\n");
	if (!existsSync(join(dir, ".git"))) {
		spawnSync("git", ["init", "-q"], { cwd: dir, env: { ...process.env, HUMMIN_MEMORY: "0" } });
	}
	// Every vault touchpoint (session start, fold trigger check, tool call)
	// re-renders the canvas if entities changed, so the Obsidian view tracks
	// folds without relying on the fold child remembering to run /vault-canvas.
	refreshCanvas(dir);
	return dir;
}

function lessonToInbox(cwd: string, lesson: string, sessionFile?: string): string {
	const dir = ensureVault();
	const slug = `lesson-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const body = `---
type: lesson
date: ${new Date().toISOString().slice(0, 10)}
project: ${cwd}
session: ${sessionFile ?? "unknown"}
---

${lesson}
`;
	writeFileSync(join(dir, "inbox", `${slug}.md`), body);
	return slug;
}

// Graph canvas (jsoncanvas.org format, opens natively in Obsidian): file
// nodes pointing at entity notes, one column per entity type, edges drawn
// from each entity's "## Links" wikilinks. A derived view of the graph:
// refreshed lazily from ensureVault (only when the rendered content changes)
// plus on demand via /vault-canvas, so it can never silently fall behind the
// entities the way a fold-triggered-only render did.
const CANVAS_ENTITY_TYPES = ["project", "concept", "decision", "gotcha", "tool", "person"];
const CANVAS_TYPE_COLORS: Record<string, string> = {
	project: "1", concept: "4", decision: "5", gotcha: "2", tool: "6", person: "3",
};

function renderCanvas(dir: string): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } | undefined {
	const nodes: Record<string, unknown>[] = [];
	const idBySlug = new Map<string, string>();
	const colWidth = 320;
	const rowHeight = 110;
	const nodeWidth = 260;
	const nodeHeight = 80;

	for (const [col, type] of CANVAS_ENTITY_TYPES.entries()) {
		const typeDir = join(dir, "entities", type);
		if (!existsSync(typeDir)) continue;
		for (const [row, file] of readdirSync(typeDir).filter((f) => f.endsWith(".md")).entries()) {
			const slug = file.slice(0, -3);
			const id = `node-${idBySlug.size + 1}`;
			idBySlug.set(slug, id);
			nodes.push({
				id,
				type: "file",
				file: `entities/${type}/${file}`,
				x: col * colWidth,
				y: row * rowHeight,
				width: nodeWidth,
				height: nodeHeight,
				color: CANVAS_TYPE_COLORS[type],
			});
		}
	}
	if (nodes.length === 0) return undefined;

	const edges: Record<string, unknown>[] = [];
	// "## Links" entries are undirected "related" relations, and every entity
	// reciprocates its links per the vault contract; emitting both directions
	// renders as doubled arcs in Obsidian. One edge per unordered pair.
	const seenPairs = new Set<string>();
	for (const node of nodes) {
		const file = node.file as string;
		const content = readFileSync(join(dir, file), "utf8");
		const linksSection = content.split(/^## Links\b/m)[1] ?? "";
		for (const match of linksSection.matchAll(/\[\[([^\]|#]+)/g)) {
			const target = match[1].trim();
			const to = idBySlug.get(target);
			if (!to || to === node.id) continue;
			const pair = [node.id, to].sort().join("\u0000");
			if (seenPairs.has(pair)) continue;
			seenPairs.add(pair);
			edges.push({ id: `edge-${edges.length + 1}`, fromNode: node.id, toNode: to });
		}
	}
	return { nodes, edges };
}

export function writeCanvas(dir: string): number {
	const canvas = renderCanvas(dir);
	if (!canvas) return 0;
	writeFileSync(join(dir, "graph.canvas"), JSON.stringify(canvas, null, "\t") + "\n");
	return canvas.nodes.length;
}

/** Lazily refresh graph.canvas from ensureVault: rewrite only when the
 * rendered content differs, so unrelated vault touches never dirty the git
 * worktree. Best effort - a render failure must never break vault startup. */
function refreshCanvas(dir: string): void {
	try {
		const canvas = renderCanvas(dir);
		const next = canvas ? JSON.stringify(canvas, null, "\t") + "\n" : "";
		const path = join(dir, "graph.canvas");
		let prev: string | undefined;
		try {
			prev = readFileSync(path, "utf8");
		} catch {
			// missing canvas, write below
		}
		if (next.length > 0 && next !== prev) writeFileSync(path, next);
	} catch {
		// canvas is a convenience view, never fatal
	}
}

const AUTO_FOLD_THRESHOLD = Number(process.env.HUMMIN_MEMORY_AUTO_FOLD_THRESHOLD ?? 3);

function inboxLessonCount(dir: string): number {
	return existsSync(join(dir, "inbox")) ? readdirSync(join(dir, "inbox")).filter((f) => f.endsWith(".md")).length : 0;
}

/** Launch a fold pass as a detached child; output lands in <vault>/fold.log. */
export async function triggerAutoFold(dir: string, label: string, ctx: MemoryDispatchContext): Promise<boolean> {
	if (AUTO_FOLD_THRESHOLD <= 0) return false;
	const count = inboxLessonCount(dir);
	if (count < AUTO_FOLD_THRESHOLD) return false;
	const requested = memoryModel();
	const dispatch = await prepareMemoryDispatch(
		{
			kind: "memory-fold",
			prompt: "Fold the inbox lessons into the entity graph now, following AGENTS.md exactly.",
			cwd: dir,
			model: `${requested.provider}/${requested.modelId}`,
			thinking: "low",
		},
		ctx,
	);
	if (dispatch.action === "block") {
		ctx.ui?.notify?.(`memory auto-fold held for dispatch review ${dispatch.reviewId ?? "unknown"}: ${dispatch.reason ?? "review required"}`, "warning");
		return false;
	}
	const out = openSync(join(dir, "fold.log"), "a");
	try {
		const child = spawn(
			"hummin",
			["-p", `Fold the inbox lessons into the entity graph now, following AGENTS.md exactly. Inbox has ${count} lesson(s).`, "--provider", dispatch.configuration.provider, "--model", dispatch.configuration.modelId, "--thinking", dispatch.configuration.thinking],
			{
				cwd: dir,
				detached: true,
				stdio: ["ignore", out, out],
				env: { ...process.env, HUMMIN_MEMORY: "0" },
			},
		);
		child.unref();
	} finally {
		closeSync(out);
	}
	console.log(`vault: auto-folding ${count} lesson(s) in background (${label}); progress in fold.log`);
	return true;
}
