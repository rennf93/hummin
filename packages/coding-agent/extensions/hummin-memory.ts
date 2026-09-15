/**
 * hummin-memory: session distillation (spec 13.2, lesson mode).
 *
 * On session shutdown, distills the session into ONE lesson in a fixed shape
 * (Problem: / Approach: / Gotcha:, max 120 words) using a one-shot print-mode
 * hummin call, and appends it to the project's lessons file. If there is no
 * real lesson, the model replies NONE and nothing is stored - the store never
 * fills with junk (RoboCo memory_distiller gate).
 *
 * Idempotency: one lesson per session id; a state file marks processed
 * sessions so a re-shutdown cannot duplicate. Failures are skipped (record
 * nothing rather than storing junk).
 *
 * Config (all optional):
 *   HUMMIN_MEMORY=1            enable (default off - experimental)
 *   HUMMIN_MEMORY_PROVIDER     provider for the distillation call (default: zai)
 *   HUMMIN_MEMORY_MODEL_ID     model id (default: glm-5.3-flash)
 *   HUMMIN_MEMORY_DIR          storage dir (default: <agentDir>/memory)
 *   HUMMIN_MEMORY_MAX_CHARS    transcript tail passed to the distiller (default: 12000)
 *
 * Retrieval is v2 (relevance-floored injection at session start); lessons are
 * plain JSONL plus a human-readable markdown mirror.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

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

function distill(transcript: string, cwd: string): string | null {
	const prompt = `You are distilling a coding-agent session into exactly one reusable lesson.

Rules:
- Reply with ONLY the lesson in this exact shape:
Problem: <what the session was trying to do>
Approach: <what actually worked>
Gotcha: <the non-obvious thing a future session would need>
- Max ${LESSON_MAX_WORDS} words total.
- If there is no real lesson worth keeping, reply with exactly: NONE

Working directory: ${cwd}

Session transcript (tail):
${transcript}`;

	const provider = process.env.HUMMIN_MEMORY_PROVIDER ?? "zai";
	const modelId = process.env.HUMMIN_MEMORY_MODEL_ID ?? "glm-5.3-flash";
	const res = spawnSync("hummin", ["-p", prompt, "--provider", provider, "--model", modelId, "--thinking", "low"], {
		encoding: "utf8",
		timeout: 300_000,
		// The distillation call is itself a hummin session: disable memory inside
		// it or its shutdown handler distills again, recursing without bound.
		env: { ...process.env, HUMMIN_MEMORY: "0" },
	});
	const out = `${res.stdout ?? ""}`.trim();
	if (res.status !== 0 || !out) return null;
	if (/^NONE$/i.test(out.split("\n").at(-1)?.trim() ?? "")) return null;
	return out;
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
// Retrieval (v2): inject project-relevant lessons at session start.
// Relevance v3: project lessons always eligible (ranked by query overlap,
// then recency); cross-project lessons surface only with >= 2 keyword
// overlaps against the opening prompt. Below the floor nothing is injected -
// no briefing bloat. Deterministic: no embeddings, plain term overlap.
// =============================================================================

const RETRIEVAL_MAX_LESSONS = 3;
const RETRIEVAL_MAX_CHARS = 2000;
const CROSS_PROJECT_MIN_OVERLAP = 2;

const STOPWORDS = new Set([
	"that", "this", "with", "from", "have", "been", "were", "their", "there",
	"which", "about", "would", "could", "should", "these", "those", "then",
	"than", "them", "they", "when", "what", "your", "will", "into", "also",
	"just", "like", "over", "under", "after", "before", "only", "more",
	"most", "some", "such", "each", "very", "here", "where", "while",
]);

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_./-]+/)
			.filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
	);
}

function parentDir(cwd: string): string {
	const parts = cwd.split("/");
	parts.pop();
	return parts.join("/");
}

export function recallLessons(cwd: string, query: string): string[] {
	const file = join(memoryDir(), "lessons.jsonl");
	if (!existsSync(file)) return [];
	const queryTerms = tokenize(query);
	const scored: { lesson: string; score: number; index: number }[] = [];
	let index = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		index++;
		try {
			const record = JSON.parse(line);
			if (typeof record.lesson !== "string" || typeof record.cwd !== "string") continue;
			const overlap = [...tokenize(record.lesson)].filter((term) => queryTerms.has(term)).length;
			let score = overlap;
			if (record.cwd === cwd) {
				score += 5;
			} else if (parentDir(record.cwd) === parentDir(cwd)) {
				score += 2;
			} else if (overlap < CROSS_PROJECT_MIN_OVERLAP) {
				continue;
			}
			scored.push({ lesson: record.lesson, score, index });
		} catch {
			// skip malformed
		}
	}
	scored.sort((a, b) => b.score - a.score || b.index - a.index);
	return scored.slice(0, RETRIEVAL_MAX_LESSONS).map((entry) => entry.lesson);
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

let cachedSettings: SettingsManager | undefined;

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
			handler: async () => vaultFold("command"),
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

	// Surface memory once per session so the user knows retrieval is active
	// without a notice on every turn.
	let memoryNotified = false;

	pi.on("before_agent_start", async (event, ctx) => {
		const lessons = recallLessons(process.cwd(), event?.prompt ?? "");
		if (lessons.length === 0) return;
		let briefing = "";
		const parts: string[] = [];
		for (const lesson of [...lessons].reverse()) {
			if (briefing.length + lesson.length > RETRIEVAL_MAX_CHARS) break;
			briefing += `\n\n${lesson}`;
			parts.push(lesson);
		}
		if (parts.length === 0) return;
		if (!memoryNotified && ctx?.ui?.notify) {
			memoryNotified = true;
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

	pi.on("session_shutdown", async () => {
		try {
			const cwd = process.cwd();
			const sessionFile = newestSessionFile(cwd);
			if (!sessionFile || alreadyProcessed(sessionFile)) return;

			const tail = readTranscriptTail(sessionFile, Number(process.env.HUMMIN_MEMORY_MAX_CHARS ?? 12000));
			if (tail.length < 120) return; // trivial session, nothing to distill

			const lesson = distill(tail, cwd);
			if (!lesson) return; // NONE or failed: store nothing

			markProcessed(sessionFile);
			mkdirSync(memoryDir(), { recursive: true });
			const record = {
				timestamp: new Date().toISOString(),
				cwd,
				project: projectKey(cwd),
				session: sessionFile.split("/").pop(),
				lesson,
			};
			appendFileSync(join(memoryDir(), "lessons.jsonl"), `${JSON.stringify(record)}\n`);

			// human-readable mirror per project
			const mdPath = join(memoryDir(), `${record.project}.lessons.md`);
			if (!existsSync(mdPath)) {
				writeFileSync(mdPath, `# Lessons - ${cwd}\n\n`);
			}
			appendFileSync(mdPath, `## ${record.timestamp}\n\n${lesson}\n\n`);

			// vault mode: queue the lesson for the fold pass
			if (settings.getMemoryMode() === "vault") {
				lessonToInbox(cwd, lesson, record.session);
			}
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

const FOLD_TIMEOUT_SEC = 900;

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
- Before creating an entity, search entities/ for an existing one; extend it
  instead of duplicating. Never invent facts that are not in an inbox lesson.
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

function vaultFold(label: string): void {
	const dir = ensureVault();
	const inboxCount = existsSync(join(dir, "inbox")) ? readdirSync(join(dir, "inbox")).filter((f) => f.endsWith(".md")).length : 0;
	if (inboxCount === 0) {
		console.log("vault: inbox is empty, nothing to fold");
		return;
	}
	console.log(`vault: folding ${inboxCount} lesson(s) from ${dir}`);
	const provider = process.env.HUMMIN_MEMORY_PROVIDER ?? "zai";
	const modelId = process.env.HUMMIN_MEMORY_MODEL_ID ?? "glm-5.3-flash";
	const res = spawnSync("hummin", [
		"-p", `Fold the inbox lessons into the entity graph now, following AGENTS.md exactly. Inbox has ${inboxCount} lesson(s).`,
		"--provider", provider, "--model", modelId, "--thinking", "low",
	], {
		cwd: dir,
		encoding: "utf8",
		timeout: FOLD_TIMEOUT_SEC * 1000,
		env: { ...process.env, HUMMIN_MEMORY: "0" },
	});
	const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
	console.log(out.split("\n").slice(-6).join("\n"));
	if (res.status !== 0) {
		console.log(`vault: fold exited ${res.status}`);
		process.exitCode = 1;
	} else {
		console.log(`vault: fold complete (${label})`);
		writeCanvas(dir);
	}
}
