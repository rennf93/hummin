/**
 * hummin-laya: laya System-1 decision tool for the local fleet.
 *
 * laya_decide sends a state plus typed questions (choice / score / noul) to
 * the laya service (launchd com.hummin.laya, port 9989, served by
 * ~/colibri/serve-laya.sh) and returns calibrated answers in a single forward
 * pass. laya generates no text, so it cannot hallucinate an answer: it is a
 * fast second opinion for the main model when it is torn between options,
 * unsure whether to proceed, or wants a confidence check before acting.
 *
 * Logs: ~/Library/Logs/laya-server.log
 * Restart: launchctl kickstart -k gui/501/com.hummin.laya
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readLayaGateLines } from "./lib/friction.ts";

const LAYA_URL = process.env.HUMMIN_LAYA_URL?.trim() || "http://127.0.0.1:9989/v1/systemone";
/** Shared fleet key from the environment (exported in ~/.zshrc, same source as
 * hummin-local.ts uses). Never hardcoded here: extensions can end up in repos
 * and screenshots; the literal key only lives in the serve scripts and plists. */
const LAYA_API_KEY = process.env.COLI_API_KEY?.trim() || "";
const TIMEOUT_MS = 15_000;
const WARM_TIMEOUT_MS = 45_000;
const MAX_QUESTIONS = 8;
const MAX_STATE_CHARS = 50_000;
const LOW_CONFIDENCE = 0.5;

type QuestionType = "choice" | "score" | "noul";

interface QuestionInput {
	name: string;
	type: QuestionType;
	instructions: string;
	criteria?: Record<string, string> | string[];
}

interface Answer {
	type?: string;
	choice?: string;
	score?: number;
	noul?: number;
	probabilities?: Record<string, number>;
	legend?: Record<string, string>;
	confidence?: number;
	answer_confidence?: number;
}

interface LayaResponse {
	answers?: Record<string, Answer>;
	routing?: { model?: string };
}

const pct = (n: number | undefined): string =>
	typeof n === "number" ? `${Math.round(n * 100)}%` : "?";

// --- Automatic System-1 reads (no model opt-in required) ---
// Kill switches: HUMMIN_LAYA_STEER=off disables the per-turn read,
// HUMMIN_LAYA_GATE=off the bash tripwire, HUMMIN_LAYA_TRIAGE=off the
// test-failure triage, and HUMMIN_LAYA_INTAKE=off the distill worker's
// intake read. All fail open: if laya is unreachable or slow, the turn, the
// command, the tool result, and the lesson proceed untouched. Every read is
// appended to laya-gate.log as {ts, type: "read", kind, p}.

const STEER_MIN_PROMPT_CHARS = 24;
const STEER_DESTRUCTIVE_THRESHOLD = 0.7;
const GATE_BLOCK_THRESHOLD = 0.75;
const GATE_TIMEOUT_MS = 4_000;
const GATE_CONFIRM_MARKER = "# laya-gate: confirmed";

/** Destructive-intent thresholds. Resolution order: env
 * (HUMMIN_LAYA_GATE_THRESHOLD / HUMMIN_LAYA_STEER_THRESHOLD), then the
 * settings key (layaGateThreshold / layaSteerThreshold), then the built-in
 * default. Guarded for runtime binaries whose SettingsManager predates the
 * settings; unreadable settings fall back too. */
function resolveThreshold(envName: string, read: (settings: SettingsManager) => number | undefined, fallback: number): number {
	const env = process.env[envName]?.trim();
	if (env !== undefined && env !== "") {
		const n = Number(env);
		if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	}
	try {
		const stored = read(SettingsManager.create(process.cwd()));
		if (typeof stored === "number" && stored >= 0 && stored <= 1) return stored;
	} catch {
		// unreadable settings: fall through to the default
	}
	return fallback;
}

/** The bash gate block threshold (default 0.75). */
export function layaGateThreshold(): number {
	return resolveThreshold("HUMMIN_LAYA_GATE_THRESHOLD", (s) => s.getLayaGateThreshold?.(), GATE_BLOCK_THRESHOLD);
}

/** The per-turn destructive steer threshold (default 0.7). */
export function layaSteerThreshold(): number {
	return resolveThreshold("HUMMIN_LAYA_STEER_THRESHOLD", (s) => s.getLayaSteerThreshold?.(), STEER_DESTRUCTIVE_THRESHOLD);
}
const READ_ONLY_BASH =
	/^\s*(ls|pwd|cat|head|tail|grep|rg|find|which|type|file|stat|du|df|wc|date|whoami|id|uname|hostname|uptime|ps|sort|uniq|cut|tr|awk|sed -n|diff|basename|dirname|realpath|readlink|true|false|test|\[|sleep|wait|printf|echo|env|printenv|locale|tput|column|paste|comm|join|xargs(?! .*(rm|mv|cp|chmod|chown|kill|sh|bash|zsh))|seq|yes|md5|shasum|sha1sum|sha256sum|base64|xxd|od|hexdump|node --version|node -v|python3? --version|npm (ls|outdated|view|run (build|check|lint|typecheck)|test|prefix|root|bin|config get)|npx --version|git (status|log|diff|show|branch|remote|tag|rev-parse|describe|ls-files|blame|shortlog|config --get|stash list)|gh (api|run (view|list|watch)|pr (view|list|diff|checks)|issue (view|list)|release (view|list)|status|auth status|repo view|browse)|launchctl (list|print)|brew (list|info|search|outdated)|curl -[a-zA-Z]*[sI]|curl(?! .*(-X (POST|PUT|DELETE|PATCH)|-d |--data|-T |--upload-file))(?: |$))\b/;

/** Split a command into pipeline segments the way bash sees them: on ;, &&,
 * ||, and | that are OUTSIDE quotes. The naive `split(/\|/)` broke allowlist
 * checks whenever a quoted pattern contained `|` (e.g. `rg 'a|b'`, `awk -F'|'`),
 * which was a major source of gate false positives. Trailing separators and
 * redirect operators are stripped from each segment. */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[i + 1];
			i++;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "|") {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	// Strip trailing redirects (2>&1, >/dev/null, <file) and trim; drop empties.
	return segments
		.map((s) => s.replace(/\s*\d?[<>]&?\d?\s*[^\s|;&]+\s*$/g, "").trim())
		.filter(Boolean);
}

interface LayaNoulPayload {
	answers?: Record<string, { noul?: number; confidence?: number }>;
}

/** Audit trail for the bash gate: one JSON line per block and per marker
 * confirmation, so self-served bypasses are visible after the fact. */
function auditGate(entry: { type: "block" | "confirmed"; command: string; p?: number }): void {
	try {
		appendFileSync(
			join(getAgentDir(), "laya-gate.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
		);
	} catch {
		// Audit logging must never break the gate itself.
	}
}

/** The score of the most recent block of this exact command. Confirmations
 * carry no laya read of their own, so the joined block score is what makes
 * "lowest confirmed P" calibration data possible. Fail-silent. */
function lastBlockScore(command: string): number | undefined {
	try {
		const lines = readLayaGateLines();
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]) as { type?: string; command?: string; p?: number };
				if (entry.type === "block" && entry.command === command && typeof entry.p === "number") return entry.p;
			} catch {
				// corrupt line: keep scanning
			}
		}
	} catch {
		// no readable log
	}
	return undefined;
}

/** Audit trail for automatic laya reads: one JSON line per read that returned
 * a score. The distill worker logs its own intake read (same shape) directly. */
function auditRead(kind: "steer" | "gate" | "decide" | "triage", p: number): void {
	try {
		appendFileSync(
			join(getAgentDir(), "laya-gate.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), type: "read", kind, p })}\n`,
		);
	} catch {
		// Audit logging must never break the reader.
	}
}

/** One-question noul read from laya; null on any failure or timeout. */
async function layaNoul(state: string, name: string, instructions: string): Promise<{ noul: number } | null> {
	if (!LAYA_API_KEY) return null;
	try {
		const response = await layaFetch(
			JSON.stringify({ state, questions: { [name]: { type: "noul", instructions } } }),
			GATE_TIMEOUT_MS,
		);
		if (!response.ok) return null;
		const payload = (await response.json()) as LayaNoulPayload;
		const answer = payload.answers?.[name];
		return typeof answer?.noul === "number" ? { noul: answer.noul } : null;
	} catch {
		return null;
	}
}

let checkpointWarmed = false;
/** POST to laya with auth + a per-attempt timeout. Retries once on abort/timeout
 * (the cold-start checkpoint load) so a just-started server does not fail the
 * very first call. Any other error is rethrown for the caller to handle. */
async function layaFetch(body: string, timeoutMs: number): Promise<Response> {
	const common = {
		method: "POST" as const,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${LAYA_API_KEY}` },
		body,
	};
	try {
		return await fetch(LAYA_URL, { ...common, signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		if (err instanceof Error && /abort|timeout|econnreset|eclosed|eai_again|enotfound|econnrefused/i.test(err.message)) {
			return await fetch(LAYA_URL, { ...common, signal: AbortSignal.timeout(timeoutMs) });
		}
		throw err;
	}
}

/** Best-effort single load of the laya checkpoint. Called once at startup and
 * awaited on the first agent turn if the startup prime has not finished; fails
 * silently so an unreachable server never blocks the turn. */
async function layaWarmCheckpoint(): Promise<void> {
	if (!LAYA_API_KEY || checkpointWarmed) return;
	try {
		await layaFetch(JSON.stringify({ state: "warmup", questions: { warmup: { type: "noul", instructions: "Warmup." } } }), WARM_TIMEOUT_MS);
		checkpointWarmed = true;
	} catch {
		// best-effort: leave the flag clear so a later call can retry the load
	}
}

function formatAnswer(name: string, q: QuestionInput, a: Answer): string {
	switch (q.type) {
		case "choice": {
			const top = a.choice ?? "(none)";
			const others = Object.entries(a.probabilities ?? {})
				.filter(([label]) => label !== top)
				.sort((x, y) => y[1] - x[1])
				.map(([label, p]) => `${label} ${pct(p)}`)
				.join(", ");
			return `${name}: ${top} (${pct(a.probabilities?.[top])}${others ? `; then ${others}` : ""})`;
		}
		case "score": {
			const levels = (q.criteria as string[] | undefined) ?? Object.values(a.legend ?? {});
			const s = typeof a.score === "number" ? a.score : -1;
			const nearest = s >= 0 ? levels[Math.min(levels.length - 1, Math.max(0, Math.round(s)))] : "?";
			return `${name}: ${s >= 0 ? s.toFixed(2) : "?"} of ${levels.length - 1} ("${nearest}"), top mass ${pct(
				Math.max(...Object.values(a.probabilities ?? { 0: 0 })),
			)}`;
		}
		case "noul": {
			const p = typeof a.noul === "number" ? a.noul : -1;
			const verdict = p < 0 ? "?" : p >= 0.5 ? "yes" : "no";
			return `${name}: P(true) ${p >= 0 ? p.toFixed(3) : "?"} -> lean ${verdict} (${pct(
				Math.max(p, 1 - p),
			)} sure)`;
		}
	}
}

// --- Test-failure triage -----------------------------------------------------
// After a bash tool result that looks like a failing test run, ONE laya read
// estimates the probability that the failure was caused by the agent's current
// change. Below TRIAGE_ADVISORY_BELOW, a hidden advisory tells the model to
// verify the failure reproduces on HEAD before fixing anything. Kill switch:
// HUMMIN_LAYA_TRIAGE=off. Fail open: the read result never modifies the tool
// result and any error is swallowed.

const TRIAGE_ADVISORY_BELOW = 0.45;
const TRIAGE_RATE_LIMIT_MS = 10 * 60 * 1000;
const TRIAGE_MAX_RESULT_CHARS = 2000;
/** At most one triage read per window; module-level so it spans sessions. */
let lastTriageReadAt = 0;

const TEST_RUNNER_WORDS = /\b(?:vitest|pytest|cargo test|go test|node --test|jest|npm test|npm run test)\b/;
const TEST_RUNNER_SCRIPT = /(?:^|[\s;&|])\.\/test\.sh\b/;

/** Pure: does the command look like a test run? */
export function looksLikeTestRun(command: string): boolean {
	return TEST_RUNNER_WORDS.test(command) || TEST_RUNNER_SCRIPT.test(command);
}

/** Pure: does test-runner output look like a failing run? Line-start FAIL
 * markers, nonzero failure counts, assertion and panic keywords - kept
 * conservative so passing output ("0 failed", "5 passed") never matches. */
export function looksLikeTestFailure(text: string): boolean {
	return /(?:^|\n)\s*(?:--- )?FAIL(?:ED)?\b|\b[1-9]\d* (?:failed|failing)\b|\bnot ok\b|\bfailing tests:\b|\bAssertionError\b|\bpanicked at\b|\btest result: FAILED\b|\berror: test failed\b/i.test(text);
}

/** Pure: the hidden advisory for a triage read, or undefined when the failure
 * is probably caused by the current change (no message sent). */
export function triageAdvisory(score: number): string | undefined {
	if (score >= TRIAGE_ADVISORY_BELOW) return undefined;
	return `Laya triage: this failure may pre-date your change (P(caused_by_change)=${score.toFixed(2)}). Verify it reproduces on HEAD (git status/stash or a clean checkout) before attempting fixes.`;
}

/** Pure: rate-limit decision for triage reads (at most one per window). */
export function triageRateLimited(now: number, lastReadAt: number): boolean {
	return now - lastReadAt < TRIAGE_RATE_LIMIT_MS;
}

function triageState(command: string, resultText: string): string {
	return `A coding agent ran this test command in the user's project:\n\n${command.slice(0, 500)}\n\nOutput tail:\n${resultText.slice(-TRIAGE_MAX_RESULT_CHARS)}`;
}

export default function humminLaya(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "laya_decide",
		label: "Laya Decide",
		description:
			"Fast calibrated second opinion (System-1) on structured decisions: pick between named options, a yes/no judgment with P(true), or a rating on an ordinal rubric. One forward pass, no text generation, so it cannot make things up. Consult it when you are torn between options, unsure whether to proceed with a risky action, or want an independent confidence check on a decision. It cannot do open Q&A, reasoning, or more than ~20 options.",
		promptSnippet:
			"laya_decide: ask the laya System-1 engine for a calibrated second opinion on a choice, yes/no gate, or rubric score before committing to a decision",
		parameters: Type.Object({
			state: Type.String({
				description:
					"The situation to decide over: the relevant facts, constraints, and the options or claim in context (max 50k chars). laya reads only this text, so include everything the decision needs.",
			}),
			questions: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short snake_case key for the answer, e.g. proceed_first" }),
					type: Type.Union([Type.Literal("choice"), Type.Literal("score"), Type.Literal("noul")], {
						description: "choice = pick one option, score = ordinal rubric level, noul = yes/no with P(true)",
					}),
					instructions: Type.String({ description: "What to decide, phrased as a question over the state" }),
					criteria: Type.Optional(
						Type.Union([Type.Record(Type.String(), Type.String()), Type.Array(Type.String())], {
							description:
								"choice: object mapping label -> description (or array of labels). score: array of level descriptions ordered worst to best. noul: optional object with optional 'true'/'false' descriptions.",
						}),
					),
				}),
				{ maxItems: MAX_QUESTIONS, description: `1 to ${MAX_QUESTIONS} questions, answered in one pass` },
			),
		}),
		async execute(_toolCallId, params) {
			if (!LAYA_API_KEY) {
				return {
					content: [{ type: "text", text: "Error: COLI_API_KEY is not set in this Hummin process. Export it (it is in ~/.zshrc) and restart Hummin." }],
					isError: true,
					details: {},
				};
			}
			if (!params.state.trim()) {
				return { content: [{ type: "text", text: "Error: empty state" }], isError: true, details: {} };
			}
			if (params.questions.length === 0) {
				return { content: [{ type: "text", text: "Error: no questions given" }], isError: true, details: {} };
			}

			const questions: Record<string, unknown> = {};
			for (const q of params.questions) {
				if (!/^[a-zA-Z0-9_-]{1,64}$/.test(q.name)) {
					return {
						content: [{ type: "text", text: `Error: question name '${q.name}' must be snake_case, max 64 chars` }],
						isError: true,
						details: {},
					};
				}
				questions[q.name] = q.criteria !== undefined
					? { type: q.type, instructions: q.instructions, criteria: q.criteria }
					: { type: q.type, instructions: q.instructions };
			}

			let response: Response;
			try {
				response = await layaFetch(JSON.stringify({ state: params.state.slice(0, MAX_STATE_CHARS), questions }), TIMEOUT_MS);
			} catch (err) {
				const msg = err instanceof Error && /abort|timeout/i.test(err.message)
					? `laya did not answer within ${TIMEOUT_MS / 1000}s (cold checkpoint may still be loading)`
					: `laya service unreachable at ${LAYA_URL}`;
				return {
					content: [{
						type: "text",
						text: `${msg}. Check it with: curl -m 3 http://127.0.0.1:9989/health, restart with: launchctl kickstart -k gui/501/com.hummin.laya`,
					}],
					isError: true,
					details: {},
				};
			}

			if (!response.ok) {
				const detail = (await response.text()).slice(0, 300);
				return {
					content: [{ type: "text", text: `laya returned HTTP ${response.status}: ${detail}` }],
					isError: true,
					details: {},
				};
			}

			const payload = (await response.json()) as LayaResponse;
			const lines: string[] = [];
			for (const q of params.questions) {
				const a = payload.answers?.[q.name];
				lines.push(a ? formatAnswer(q.name, q, a) : `${q.name}: (no answer returned)`);
			}
			const weakest = Math.min(
				...params.questions
					.map((q) => payload.answers?.[q.name]?.answer_confidence ?? payload.answers?.[q.name]?.confidence)
					.filter((c): c is number => typeof c === "number"),
			);
			// For the multi-question tool read, the audited p is the weakest
			// answer confidence - the same signal the result text surfaces.
			if (isFinite(weakest)) auditRead("decide", weakest);
			if (isFinite(weakest) && weakest < LOW_CONFIDENCE) {
				lines.push(
					`note: weakest answer confidence ${pct(weakest)} is below ${pct(LOW_CONFIDENCE)}; weigh your own judgment and the state text more than laya here`,
				);
			}
			if (payload.routing?.model) {
				lines.push(`(laya checkpoint: ${payload.routing.model})`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	// Prime the laya checkpoint once at startup so the first real call does not
	// hit the cold prefill wall (which would exceed the request timeout). Fire
	// and forget: a dead server never blocks process start.
	layaWarmCheckpoint().catch(() => undefined);

	// Per-turn steering: read the user prompt before the agent starts and, only
	// when laya is confident the request involves destructive action, inject a
	// quiet context message steering the model to verify and confirm first.
	if (process.env.HUMMIN_LAYA_STEER !== "off") {
		pi.on("before_agent_start", async (event) => {
			const prompt = event.prompt.trim();
			if (prompt.length < STEER_MIN_PROMPT_CHARS || prompt.startsWith("/")) return undefined;
			await layaWarmCheckpoint();
			const read = await layaNoul(
				prompt.slice(0, 4000),
				"destructive_intent",
				"Fulfilling this request requires destructive or hard-to-reverse actions such as deleting, overwriting, force-pushing, or dropping data.",
			);
			if (read) auditRead("steer", read.noul);
			if (!read || read.noul < layaSteerThreshold()) return undefined;
			return {
				message: {
					customType: "laya-read",
					content: `[laya System-1 read, P=${read.noul.toFixed(2)}] This request may require destructive or hard-to-reverse actions. Before deleting, overwriting, or dropping anything: verify the exact target, check it is backed up or reproducible, and ask the user if the scope is not explicit.`,
					display: false,
					details: {},
				},
			};
		});
	}

	// Bash tripwire: laya reads each non-read-only command before it runs and
	// blocks it once when it scores P >= 0.75 as irreversibly destructive. The
	// block reason makes the model confirm with the user or verify backups;
	// re-running with the confirm marker documents that and passes the gate.
	if (process.env.HUMMIN_LAYA_GATE !== "off") {
		const blockedOnce = new Set<string>();
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const trimmed = command.trim();
			if (!trimmed || trimmed.includes(GATE_CONFIRM_MARKER)) {
				const bare = trimmed.replace(GATE_CONFIRM_MARKER, "").trim();
				if (trimmed.includes(GATE_CONFIRM_MARKER) && bare) {
					auditGate({ type: "confirmed", command: bare, p: lastBlockScore(bare) });
				}
				blockedOnce.delete(bare);
				return undefined;
			}
			const segments = splitSegments(trimmed);
			if (segments.length > 0 && segments.every((s) => READ_ONLY_BASH.test(s))) return undefined;
			const read = await layaNoul(
				`A coding agent is about to run this bash command in the user's project directory:\n\n${trimmed.slice(0, 2000)}\n\nNotes: piping into head/tail/grep/sort only filters output. Reading files, git log/diff/show, and network read commands (gh api, gh run view, curl GET) inspect state and cannot destroy anything. Only writes, deletes, git history rewriting, and data dropping are destructive.`,
				"destructive",
				"If run as-is, this command would irreversibly destroy work that is not recoverable: overwriting or deleting user files, rewriting git history, dropping databases, or killing processes. Read-only inspection, version-control queries, and network reads must score LOW even if unfamiliar.",
			);
			if (!read) return undefined;
			auditRead("gate", read.noul);
			if (read.noul < layaGateThreshold()) {
				blockedOnce.delete(trimmed);
				return undefined;
			}
			const repeat = blockedOnce.has(trimmed);
			blockedOnce.add(trimmed);
			auditGate({ type: "block", command: trimmed, p: read.noul });
			return {
				block: true,
				reason: `[laya gate] laya scores this command P=${read.noul.toFixed(2)} as irreversibly destructive. Do not simply retry it. Either (1) confirm with the user that the target is disposable, or (2) verify it is backed up or reproducible. Once confirmed, re-run the same command with '${GATE_CONFIRM_MARKER}' appended so the gate lets it through.${
					repeat
						? "\n\nThis exact command was already blocked once. Do NOT retry with variations. Use the ask_user tool to ask the user now, quoting this command and the score."
						: ""
				}`,
			};
		});
	}

	// Test-failure triage: after a failing test run, one laya read judges
	// whether the failure predates the agent's change. All failure modes fail
	// open; nothing here may throw into the tool result path.
	if (process.env.HUMMIN_LAYA_TRIAGE !== "off") {
		pi.on("tool_result", async (event) => {
			try {
				if (event.toolName !== "bash") return;
				const command = (event.input as { command?: unknown }).command;
				if (typeof command !== "string") return;
				if (!looksLikeTestRun(command)) return;
				const resultText = event.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (!looksLikeTestFailure(resultText)) return;
				const now = Date.now();
				if (triageRateLimited(now, lastTriageReadAt)) return;
				// Consumed on attempt, not success, so a dead laya cannot turn
				// every failing test into another timeout wait.
				lastTriageReadAt = now;
				const read = await layaNoul(
					triageState(command, resultText),
					"caused_by_change",
					"Score the probability that this test failure was caused by the coding agent's current changes rather than by pre-existing breakage, flaky tests, or environment problems.",
				);
				if (!read) return;
				auditRead("triage", read.noul);
				const advisory = triageAdvisory(read.noul);
				if (advisory === undefined) return;
				pi.sendMessage({ customType: "hummin-laya-triage", content: advisory, display: false, details: {} });
			} catch {
				// Never throw into the tool result path.
			}
		});
	}
}
