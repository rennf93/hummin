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
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LESSON_MAX_WORDS = 120;

function agentDir(): string {
	return process.env.HUMMIN_CODING_AGENT_DIR ?? join(homedir(), ".hummin", "agent");
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
		// node has no atomic rename flag here; rename is atomic on POSIX
		import("node:fs").then((fs) => fs.renameSync(statePath() + ".tmp", statePath()));
	} catch {
		// fail-open: bookkeeping must never break shutdown
	}
}

export default function humminMemory(pi: ExtensionAPI): void {
	if (process.env.HUMMIN_MEMORY !== "1") {
		return;
	}

	if (process.env.HUMMIN_MEMORY_MODE === "vault") {
		ensureVault();
		pi.registerCommand("vault-fold", {
			description: "Fold inbox lessons into the vault entity graph",
			handler: async () => vaultFold("command"),
		});
		pi.registerCommand("vault-recall", {
			description: "Search vault entities",
			handler: async (args, ctx) => {
				const query = (args ?? "").trim().toLowerCase();
				if (!query) {
					ctx.ui.notify("usage: /vault-recall <query>", "warning");
					return;
				}
				const matches: string[] = [];
				const entitiesDir = join(vaultDir(), "entities");
				const walk = (dir: string) => {
					for (const f of readdirSync(dir)) {
						const full = join(dir, f);
						if (!existsSync(full)) continue;
						try {
							if (full.endsWith(".md")) {
								const content = readFileSync(full, "utf8");
								if (content.toLowerCase().includes(query)) {
									const hits = content.split("\n").filter((l) => l.toLowerCase().includes(query)).slice(0, 3);
									matches.push(`${full.replace(vaultDir() + "/", "")}\n  ${hits.join("\n  ")}`);
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
			if (process.env.HUMMIN_MEMORY_MODE === "vault") {
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

function vaultDir(): string {
	return process.env.HUMMIN_MEMORY_VAULT_DIR ?? join(agentDir(), "vault");
}

function vaultContract(): string {
	return `# Vault conventions

This vault is the persistent memory of hummin coding sessions. You are the
curator. Rules:

- Entity files live at entities/<type>/<slug>.md with type one of:
  project, concept, decision, gotcha, tool, person.
- Slug is kebab-case. Reference entities anywhere in the vault as [[slug]].
- Facts inside entities are dated and attributed: (from [[lesson-slug]], YYYY-MM-DD).
- Before creating an entity, search entities/ for an existing one; extend it
  instead of duplicating. Never invent facts that are not in an inbox lesson.
- Each entity ends with a "## Links" section listing related [[entities]].
- Keep entity files short: one overview paragraph, then dated bullet facts.

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

function ensureVault(): string {
	const dir = vaultDir();
	for (const sub of ["inbox", "processed", join("entities", "project"), join("entities", "concept"), join("entities", "decision"), join("entities", "gotcha"), join("entities", "tool")]) {
		mkdirSync(join(dir, sub), { recursive: true });
	}
	if (!existsSync(join(dir, "AGENTS.md"))) writeFileSync(join(dir, "AGENTS.md"), vaultContract());
	if (!existsSync(join(dir, "log.md"))) writeFileSync(join(dir, "log.md"), "# Fold log\n");
	if (!existsSync(join(dir, ".git"))) {
		spawnSync("git", ["init", "-q"], { cwd: dir });
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
	}
}
