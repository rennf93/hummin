/**
 * hummin-memory: session distillation (spec 13.2, lesson mode).
 *
 * On session shutdown, the session is queued for distillation into ONE lesson
 * in a fixed shape (Problem: / Approach: / Gotcha:, max 120 words). A detached
 * worker makes the one-shot print-mode hummin call and appends the lesson to
 * the project's lessons file, so shutdown never blocks on the model call. If there is no
 * real lesson, the model replies NONE and nothing is stored - the store never
 * fills with junk (RoboCo memory_distiller gate).
 *
 * Idempotency: one lesson per session id; a state file marks processed
 * sessions so a re-shutdown cannot duplicate. Failures are skipped (record
 * nothing rather than storing junk).
 *
 * Config (all optional):
 *   HUMMIN_MEMORY=1            enable (default off - experimental)
 *   HUMMIN_MEMORY_PROVIDER     provider for fold/distill calls; overrides the
 *                              session's selected model (default: the model
 *                              selected in the session, falling back to zai)
 *   HUMMIN_MEMORY_MODEL_ID     model id for fold/distill calls (default: the
 *                              session's selected model, falling back to
 *                              glm-5.3-flash)
 *   HUMMIN_MEMORY_DIR          storage dir (default: <agentDir>/memory)
 *   HUMMIN_MEMORY_MAX_CHARS    transcript tail passed to the distiller (default: 12000)
 *   HUMMIN_MEMORY_AUTO_FOLD_THRESHOLD  inbox lesson count that triggers an
 *                              automatic fold pass (default 3; 0 disables)
 *
 * In vault mode the fold pass also runs automatically: at session start, on
 * agent_end, and after shutdown distillation, whenever the inbox holds at
 * least the threshold number of lessons. Folds run as a detached hummin
 * child (HUMMIN_MEMORY=0) writing to <vault>/fold.log, so neither startup,
 * turns, nor shutdown ever block on the fold.
 *
 * Retrieval: one relevance-floored injection on the session's first prompt
 * (never per turn - the briefing must not duplicate into session history),
 * plus a `vault` tool for on-demand search over lessons and vault entities.
 * Lessons are plain JSONL plus a human-readable markdown mirror.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, appendFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { MEMORY_WORKER_SOURCE, type MemoryFoldJob } from "./lib/memory-workers.ts";

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

function sessionDirFor(cwd: string): string {
	return join(agentDir(), "sessions", `--${projectKey(cwd)}--`);
}

function newestSessionFile(cwd: string): string | undefined {
	const dir = sessionDirFor(cwd);
	if (!existsSync(dir)) return undefined;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ f, mtime: existsSync(join(dir, f)) ? 0 : 0 }));
	// newest by name (timestamp prefix) - session names sort chronologically
	files.sort((a, b) => b.f.localeCompare(a.f));
	const newest = files[0]?.f;
	return newest ? join(dir, newest) : undefined;
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
function enqueueDistill(sessionFile: string, cwd: string, vaultMode: boolean): void {
	const tail = readTranscriptTail(sessionFile, Number(process.env.HUMMIN_MEMORY_MAX_CHARS ?? 12000));
	if (tail.length < 120) return; // trivial session, nothing to distill

	const dir = memoryDir();
	mkdirSync(join(dir, "pending"), { recursive: true, mode: 0o700 });
	const pendingPath = join(dir, "pending", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	writeFileSync(
		pendingPath,
		JSON.stringify({
			memoryDir: dir,
			sessionFile,
			cwd,
			tail,
			provider: memoryModel().provider,
			modelId: memoryModel().modelId,
			project: projectKey(cwd),
			session: sessionFile.split("/").pop(),
			vaultMode,
			vaultDir: vaultDir(cachedSettings),
		}),
		{ mode: 0o600 },
	);

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

	const child = spawn(process.execPath, [ensureDistillWorker(), pendingPath], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, HUMMIN_MEMORY: "0" },
	});
	child.unref();
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
// Rank by overlap, then project identity, then recency. No directory bonuses.
// =============================================================================

const RETRIEVAL_MAX_LESSONS = 3;
const RETRIEVAL_MAX_CHARS = 2000;
const CROSS_PROJECT_MIN_OVERLAP = 2;
/** Bonus when the full multi-word query appears contiguously in a lesson. */
const PHRASE_BONUS = 2;
/** Max bonus for newer lessons (linearly decaying over the past year). */
const RECENCY_BONUS_MAX = 1;
const RECENCY_WINDOW_DAYS = 365;
const BRIEFING_CHECKED = "hummin-memory-briefing-checked";

const STOPWORDS = new Set([
	"that", "this", "with", "from", "have", "been", "were", "their", "there",
	"which", "about", "would", "could", "should", "these", "those", "then",
	"than", "them", "they", "when", "what", "your", "will", "into", "also",
	"just", "like", "over", "under", "after", "before", "only", "more",
	"most", "some", "such", "each", "very", "here", "where", "while",
	"problem", "approach", "gotcha", "please", "help", "need", "want", "the", "and", "for", "are", "was",
]);

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_./-]+/)
			.filter((word) => word.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(word)),
	);
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

export function recallLessons(
	cwd: string,
	query: string,
	limit = RETRIEVAL_MAX_LESSONS,
	scope: "project" | "all" = "project",
): string[] {
	const file = join(memoryDir(), "lessons.jsonl");
	if (!existsSync(file)) return [];
	const queryTerms = tokenize(query);
	if (queryTerms.size === 0) return [];
	const project = resolve(cwd);
	const scored: { lesson: string; score: number; sameProject: boolean; index: number }[] = [];
	let index = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		index++;
		try {
			const record = JSON.parse(line);
			if (typeof record.lesson !== "string" || typeof record.cwd !== "string") continue;
			const terms = tokenize(record.lesson);
			const overlap = [...terms].filter((term) => queryTerms.has(term)).length;
			const sameProject = resolve(record.cwd) === project;
			if (sameProject ? overlap === 0 : scope !== "all" || overlap < CROSS_PROJECT_MIN_OVERLAP) continue;
			const lowerLesson = record.lesson.toLowerCase();
			const lowerQuery = query.trim().toLowerCase();
			const phrase = lowerQuery.includes(" ") && lowerLesson.includes(lowerQuery) ? PHRASE_BONUS : 0;
			scored.push({ lesson: record.lesson, score: overlap + phrase + recencyBonus(record), sameProject, index });
		} catch {
			// skip malformed
		}
	}
	scored.sort((a, b) => b.score - a.score || Number(b.sameProject) - Number(a.sameProject) || b.index - a.index);
	return scored.slice(0, limit).map((entry) => entry.lesson);
}

/**
 * On-demand search for the `vault` tool: project lessons (cross-project
 * included by the relevance floor) plus vault entity files, both scored by
 * plain term overlap. Returns a short briefing string, capped.
 */
export function searchVault(query: string, cwd: string): string {
	const sections: string[] = [];
	const lessons = recallLessons(cwd, query, 5, "all");
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
	const dir = vaultDir(cachedSettings);
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
	const file = join(memoryDir(), "lessons.jsonl");
	if (!existsSync(file)) return 0;
	try {
		return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
	} catch {
		return 0;
	}
}

function searchEntities(query: string, limit: number): string[] {
	const dir = vaultDir(cachedSettings);
	const entitiesDir = join(dir, "entities");
	if (!existsSync(entitiesDir)) return [];
	const queryTerms = [...tokenize(query)];
	if (queryTerms.length === 0) return [];
	const scored: { rel: string; score: number; hits: string[] }[] = [];
	const walk = (d: string): void => {
		for (const f of readdirSync(d)) {
			const full = join(d, f);
			try {
				if (full.endsWith(".md")) {
					const content = readFileSync(full, "utf8");
					const terms = tokenize(content);
					const score = queryTerms.filter((t) => terms.has(t)).length;
					if (score === 0) continue;
					const hits = content
						.split("\n")
						.filter((l) => {
							const ll = l.toLowerCase();
							return queryTerms.some((t) => ll.includes(t)) && l.trim().length > 0;
						})
						.slice(0, 2);
					scored.push({ rel: full.slice(dir.length + 1), score, hits });
				} else {
					walk(full);
				}
			} catch {
				// skip unreadable
			}
		}
	};
	walk(entitiesDir);
	scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
	return scored
		.slice(0, limit)
		.map((e) => `- ${e.rel} (${e.score} term overlap)\n  ${e.hits.map((h) => h.trim()).join("\n  ")}`);
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
let sessionModel: Model<any> | undefined;

function memoryModel(): { provider: string; modelId: string } {
	if (sessionModel) return { provider: sessionModel.provider, modelId: sessionModel.id };
	return {
		provider: cachedSettings?.getMemoryProvider() ?? "zai",
		modelId: cachedSettings?.getMemoryModelId() ?? "glm-5.3-flash",
	};
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
			return { content: [{ type: "text" as const, text: searchVault(query, ctx.cwd) }], details: {} };
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
					ctx.ui.notify(await vaultFold("command"), "info");
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
			triggerAutoFold(dir, "session start");
		});
		pi.on("agent_end", async () => {
			triggerAutoFold(ensureVault(), "agent_end");
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

	// Persist the attempt, including an empty result, outside the model context.
	// Scan all entries so reloads, resumed sessions, and tree navigation cannot
	// append another briefing. Later retrieval is explicit through the vault tool.
	let briefingCheckedFor: string | undefined;

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (briefingCheckedFor === sessionId) return;
		briefingCheckedFor = sessionId;
		if (ctx.sessionManager.getEntries().some((entry) =>
			(entry.type === "custom" && entry.customType === BRIEFING_CHECKED) ||
			(entry.type === "custom_message" && entry.customType === "hummin-memory-recall") ||
			(entry.type === "message" && entry.message.role === "user")
		)) return;
		pi.appendEntry(BRIEFING_CHECKED, { version: 1 });
		const lessons = recallLessons(ctx.cwd, event.prompt);
		if (lessons.length === 0) return;
		let briefing = "";
		const parts: string[] = [];
		for (const lesson of lessons) {
			if (briefing.length + lesson.length + 2 > RETRIEVAL_MAX_CHARS) continue;
			briefing += `\n\n${lesson}`;
			parts.push(lesson);
		}
		if (parts.length === 0) return;
		if (ctx?.ui?.notify) {
			ctx.ui.notify(`memory: ${parts.length} project lesson(s) applied to this session`, "info");
		}
		return {
			message: {
				customType: "hummin-memory-recall",
				content: [{ type: "text", text: `Project memory (${parts.length} recent lesson(s) for this project):${briefing}` }] satisfies TextContent[],
				display: false,
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
			// the model call (fail-open: memory must never break shutdown).
			enqueueDistill(sessionFile, cwd, settings.getMemoryMode() === "vault");
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
function enqueueFold(dir: string, label: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const jobPath = join(dir, ".fold-job.json");
	const { provider, modelId } = memoryModel();
	const job: MemoryFoldJob = { mode: "fold", vaultDir: dir, provider, modelId, threshold: 1, force: true, label, pendingPath: jobPath };
	writeFileSync(jobPath, JSON.stringify(job, null, 1), { mode: 0o600 });
	const child = spawn(process.execPath, [ensureMemoryWorker(), "fold", jobPath], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, HUMMIN_MEMORY: "0" },
	});
	child.unref();
}

async function vaultFold(label: string): Promise<string> {
	const dir = ensureVault();
	const inboxCount = inboxLessonCount(dir);
	if (inboxCount === 0) return "vault: inbox is empty, nothing to fold";
	enqueueFold(dir, label);
	return `vault: folding ${inboxCount} lesson(s) in background (${label}); progress in ${join(dir, "fold.log")}`;
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

function ensureVault(settings?: SettingsManager): string {
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
// from each entity's "## Links" wikilinks. Regenerated after every fold so
// the vault always has a current visual map of the graph.
const CANVAS_ENTITY_TYPES = ["project", "concept", "decision", "gotcha", "tool", "person"];
const CANVAS_TYPE_COLORS: Record<string, string> = {
	project: "1", concept: "4", decision: "5", gotcha: "2", tool: "6", person: "3",
};

export function writeCanvas(dir: string): number {
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
	if (nodes.length === 0) return 0;

	const edges: Record<string, unknown>[] = [];
	for (const node of nodes) {
		const file = node.file as string;
		const content = readFileSync(join(dir, file), "utf8");
		const linksSection = content.split(/^## Links\b/m)[1] ?? "";
		for (const match of linksSection.matchAll(/\[\[([^\]|#]+)/g)) {
			const target = match[1].trim();
			const to = idBySlug.get(target);
			if (to && to !== node.id) {
				edges.push({ id: `edge-${edges.length + 1}`, fromNode: node.id, toNode: to });
			}
		}
	}
	writeFileSync(join(dir, "graph.canvas"), JSON.stringify({ nodes, edges }, null, "\t") + "\n");
	return nodes.length;
}

const AUTO_FOLD_THRESHOLD = Number(process.env.HUMMIN_MEMORY_AUTO_FOLD_THRESHOLD ?? 3);

function inboxLessonCount(dir: string): number {
	return existsSync(join(dir, "inbox")) ? readdirSync(join(dir, "inbox")).filter((f) => f.endsWith(".md")).length : 0;
}

/** Launch a fold pass as a detached child; output lands in <vault>/fold.log. */
function triggerAutoFold(dir: string, label: string): boolean {
	if (AUTO_FOLD_THRESHOLD <= 0) return false;
	const count = inboxLessonCount(dir);
	if (count < AUTO_FOLD_THRESHOLD) return false;
	const { provider, modelId } = memoryModel();
	const out = openSync(join(dir, "fold.log"), "a");
	try {
		const child = spawn(
			"hummin",
			["-p", `Fold the inbox lessons into the entity graph now, following AGENTS.md exactly. Inbox has ${count} lesson(s).`, "--provider", provider, "--model", modelId, "--thinking", "low"],
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

