/**
 * hummin-laya: the System-1 decision layer for the local fleet.
 *
 * Exactly one decision engine answers every System-1 read at a time (laya,
 * clef, or jev; see lib/decision-engine.ts for selection and per-engine
 * settings). sys1_decide sends a state plus typed questions (choice / score /
 * noul) to the active engine and returns calibrated answers in a single
 * forward pass. The engine generates no text, so it cannot hallucinate an
 * answer: it is a fast second opinion for the main model when it is torn
 * between options, unsure whether to proceed, or wants a confidence check
 * before acting.
 *
 * Default engine laya: launchd com.hummin.laya, port 9989, served by
 * ~/colibri/serve-laya.sh. Clef: com.hummin.clef-mlx (Mac MLX, port 9987),
 * com.hummin.clef (Mac bf16 reference, port 9988), GGUF services on the NAS
 * (9993) and the laptop (9985).
 *
 * Logs: ~/Library/Logs/laya-server.log
 * Restart: launchctl kickstart -k gui/501/com.hummin.laya
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	sendTerminalNotification,
	SettingsManager,
	type TerminalNotificationChannel,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type DecisionEngineConfig,
	resolveDecisionEngine,
	sys1Disabled,
	sys1Fetch,
	sys1Noul,
} from "./lib/decision-engine.ts";
import { readLayaGateLines } from "./lib/friction.ts";
import { registerChildDispatchReviewTool } from "./lib/child-dispatch-review.ts";

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
	answer_confidence?: number;
	score?: number;
	noul?: number;
	probabilities?: Record<string, number>;
	legend?: Record<string, string>;
	confidence?: number;
}

interface LayaResponse {
	answers?: Record<string, Answer>;
	routing?: { model?: string };
}

const pct = (n: number | undefined): string =>
	typeof n === "number" ? `${Math.round(n * 100)}%` : "?";

// --- Automatic System-1 reads (no model opt-in required) ---
// Kill switches: HUMMIN_SYS1_STEER=off (or the legacy HUMMIN_LAYA_STEER=off)
// disables the per-turn read, HUMMIN_SYS1_GATE/HUMMIN_LAYA_GATE=off the bash
// tripwire, HUMMIN_SYS1_TRIAGE/HUMMIN_LAYA_TRIAGE=off the test-failure triage,
// and HUMMIN_SYS1_INTAKE/HUMMIN_LAYA_INTAKE=off the distill worker's intake
// read. All fail open: if the engine is unreachable or slow, the turn, the
// command, the tool result, and the lesson proceed untouched. Every read is
// appended to laya-gate.log as {ts, type: "read", kind, p, engine}.

const STEER_MIN_PROMPT_CHARS = 24;
/** Gray-zone block line, aligned with the settings-layer default (settings
 * getLayaGateThreshold(), 0.75) so blocking does not depend on settings being
 * readable. The deterministic classifiers own the unambiguous cases, so the
 * engine only judges unfamiliar commands. (Live probes in 2026-09 showed the
 * 0.71-0.75 band carries real signal on laya; the settings default was still
 * chosen as the single shared line to avoid one threshold for configured
 * installs and another for unreadable settings.) Each engine profile carries
 * its own default; clef ships the laya lines until recalibrated. */
export const GATE_BLOCK_THRESHOLD = 0.75;
export const GATE_CONFIRM_MARKER = "# laya-gate: confirmed";
const MAX_QUESTIONS = 8;
const MAX_STATE_CHARS = 50_000;

/** Threshold + timeout resolution for the active engine. Resolution order
 * (see lib/decision-engine.ts): HUMMIN_DECISION_* env, then legacy
 * HUMMIN_LAYA_* env and flat laya settings for the laya engine, then settings
 * decision.<engine>.*, then the engine default. Guarded for runtime binaries
 * whose SettingsManager predates the decision namespace; unreadable settings
 * fall back too. */
export function layaGateThreshold(cwd: string = process.cwd()): number {
	return resolveDecisionEngine(cwd).gateThreshold;
}

/** The per-turn destructive steer threshold for the active engine. */
export function layaSteerThreshold(cwd: string = process.cwd()): number {
	return resolveDecisionEngine(cwd).steerThreshold;
}

const READ_ONLY_BASH =
	/^\s*(ls|pwd|cat|head|tail|grep|rg|find|tree|which|type|file|stat|du|df|wc|date|whoami|id|uname|hostname|uptime|ps|lsof|netstat|sort|uniq|cut|tr|awk|sed -n|diff|cmp|basename|dirname|realpath|readlink|true|false|test|\[|sleep|wait|printf|echo|env|printenv|locale|tput|column|paste|comm|join|jq|xargs(?! .*(rm|mv|cp|chmod|chown|kill|sh|bash|zsh))|seq|yes|md5|shasum|sha1sum|sha256sum|base64|xxd|od|hexdump|node --version|node -v|python3? --version|npm (ls|outdated|view|run (build|check|lint|typecheck)|test|prefix|root|bin|config get)|npx --version|git (status|log|diff|show|branch|remote|tag|rev-parse|describe|ls-files|blame|shortlog|config --get|stash list)|gh (api|run (view|list|watch)|pr (view|list|diff|checks)|issue (view|list)|release (view|list)|status|auth status|repo view|browse)|launchctl (list|print)|brew (list|info|search|outdated)|curl -[a-zA-Z]*[sI]|curl(?! .*(-X (POST|PUT|DELETE|PATCH)|-d |--data|-T |--upload-file))(?: |$))\b/;

/** Split a command into pipeline segments the way bash sees them: on ;, &&,
 * ||, and | that are OUTSIDE quotes. The naive `split(/\|/)` broke allowlist
 * checks whenever a quoted pattern contained `|` (e.g. `rg 'a|b'`, `awk -F'|'`),
 * which was a major source of gate false positives. Trailing separators and
 * redirect operators are stripped from each segment. */
export function splitSegments(command: string): string[] {
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

/** Audit trail for the bash gate: one JSON line per block, per marker
 * confirmation, and per self-served marker anomaly, so bypasses are visible
 * after the fact. Deterministic classifier blocks carry a `rule` instead of a
 * score. Every line carries the answering engine. */
function auditGate(entry: { type: "block" | "confirmed" | "anomaly"; command: string; p?: number; rule?: string }, engine: string): void {
	try {
		appendFileSync(
			join(getAgentDir(), "laya-gate.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), engine, ...entry })}\n`,
		);
	} catch {
		// Audit logging must never break the gate itself.
	}
}

/** Marker confirmations authorize a re-run only when a block of the same
 * command exists within this window; an older block no longer counts. */
const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The most recent block of this exact command inside the confirm window, or
 * undefined. Scored blocks carry `p`; deterministic rule blocks do not. Bounds
 * the confirm escape hatch to commands the gate actually stopped recently.
 * Fail-silent. */
function recentBlockFor(command: string, now: number): { p?: number } | undefined {
	try {
		const lines = readLayaGateLines();
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]) as { type?: string; command?: string; p?: number; ts?: string };
				if (entry.type !== "block" || entry.command !== command) continue;
				const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
				if (Number.isFinite(ts) && now - ts > CONFIRM_WINDOW_MS) return undefined;
				return typeof entry.p === "number" ? { p: entry.p } : {};
			} catch {
				// corrupt line: keep scanning
			}
		}
	} catch {
		// no readable log
	}
	return undefined;
}

/** Audit trail for automatic System-1 reads: one JSON line per read that
 * returned a score, tagged with the answering engine. The distill worker logs
 * its own intake read (same shape) directly. */
function auditRead(kind: "steer" | "gate" | "decide" | "triage", p: number, engine: string): void {
	try {
		appendFileSync(
			join(getAgentDir(), "laya-gate.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), type: "read", kind, p, engine })}\n`,
		);
	} catch {
		// Audit logging must never break the reader.
	}
}

// --- Bash gate deterministic verdicts -------------------------------------------------------
//
// The laya checkpoint saturates around P 0.5-0.9 and cannot reliably separate
// canonical destructive git/filesystem operations from routine writes at the
// block line (measured 2026-09: identical scores across rubric rewrites).
// These classifiers handle the enumerable ends of the spectrum
// deterministically, in the same spirit as READ_ONLY_BASH above; laya scores
// only the gray zone between them.

export type GateSegmentVerdict =
	| { kind: "safe" }
	| { kind: "review" }
	| { kind: "destructive"; rule: string };

/** Canonical, unambiguous discards. Matched per segment before anything else
 * runs; a match blocks without a laya read. Deliberately conservative: when
 * in doubt a command stays in the laya gray zone. */
const DESTRUCTIVE_SEGMENT: readonly { rule: string; re: RegExp }[] = [
	{ rule: "git reset --hard", re: /\bgit reset\s+--hard\b/ },
	{ rule: "git clean -f", re: /\bgit clean\b[^|;&]*-[a-zA-Z]*f/ },
	{ rule: "git checkout -- <paths>", re: /\bgit checkout\b[^|;&]*\s--(\s|$)/ },
	{ rule: "git restore <paths>", re: /\bgit restore\b(?!.*--staged)/ },
	{ rule: "git stash drop/clear", re: /\bgit stash\s+(drop|clear)\b/ },
	{ rule: "git branch -D", re: /\bgit branch\s+-D\b/ },
	{ rule: "git push --force", re: /\bgit push\b[^|;&]*(--force(?!-with-lease)|\s-f(\s|$)|\s\+\S)/ },
	{ rule: "gh repo delete", re: /\bgh\s+repo\s+delete\b/ },
	{ rule: "DROP DATABASE/TABLE", re: /\bdrop\s+(database|table)\b/i },
	{ rule: "redis FLUSHALL/FLUSHDB", re: /\bflush(all|db)\b/i },
	{ rule: "docker volume delete", re: /\bdocker\s+volume\s+(rm|prune)\b/ },
	{ rule: "docker prune", re: /\bdocker\s+(system|image|container|builder)\s+prune\b/ },
	{ rule: "kubectl delete namespace", re: /\bkubectl\s+delete\b[^|;&]*\snamespace\b/ },
	{ rule: "terraform/pulumi destroy", re: /\b(terraform|pulumi)\s+destroy\b/ },
	{ rule: "aws s3 bucket delete", re: /\baws\s+s3\s+rb\b/ },
	{ rule: "mkfs", re: /\bmkfs/ },
	{ rule: "dd to device", re: /\bdd\b[^|;&]*of=\/dev\// },
];

/** System roots where a recursive chmod/chown can break the machine. Token
 * scan: `chmod -R 755 ./build` stays routine, `chmod -R 777 /` does not. */
const SYSTEM_ROOTS = new Set(["/", "~", "/etc", "/usr", "/var", "/bin", "/sbin", "/Library", "/System", "/Applications"]);

function recursiveChmodOnSystemRoot(tokens: readonly string[]): boolean {
	if (tokens[0] !== "chmod" && tokens[0] !== "chown") return false;
	if (!tokens.some((t) => t === "-R" || t === "--recursive")) return false;
	return tokens.some((t) => {
		if (SYSTEM_ROOTS.has(t)) return true;
		return (t.startsWith("/etc") || t.startsWith("/usr") || t.startsWith("/var") || t.startsWith("~/")) && t !== "~/";
	});
}

/** True when the command contains a `>` or `>>` redirect (outside quotes) to
 * a real file. splitSegments strips redirects from segments, so without this
 * check `echo x > important.txt` would fast-pass as read-only while clobbering
 * the target. fd dups (2>&1) and /dev/null are not writes. */
export function hasWriteRedirect(command: string): boolean {
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch !== ">") continue;
		// Absorb an optional leading fd number belonging to this operator
		// (e.g. the 2 in 2>/dev/null). Dup forms (2>&1, >&2) match BEFORE the
		// plain operator so ">&1" is not read as "> file &1".
		const rest = command.slice(i);
		const m = rest.match(/^\d?>&\d|^>&\d|^\d?>/);
		if (!m) continue;
		const op = m[0];
		if (op.includes("&")) {
			i += op.length - 1;
			continue;
		}
		const targetMatch = rest.slice(op.length).match(/^\s*([^\s|;&]*)/);
		const target = targetMatch ? targetMatch[1] : "";
		if (target === "/dev/null") {
			i += op.length + (targetMatch ? targetMatch[0].length : 0) - 1;
			continue;
		}
		return true;
	}
	return false;
}

/** Extra per-installation classifier patterns from settings
 * (layaGate.extraSafe / layaGate.extraDestructive regex strings). */
export interface ExtraGatePatterns {
	safe: RegExp[];
	destructive: RegExp[];
}

/** Verdict for a single pipeline segment. Order: sudo demotion, destructive
 * regexes (built-ins then settings extras), the read-only allowlist, the rm
 * target analysis, then the additive-write fast path with settings extras. */
export function gateSegmentVerdict(segment: string, extra: ExtraGatePatterns = { safe: [], destructive: [] }): GateSegmentVerdict {
	const s = segment.trim();
	if (!s) return { kind: "safe" };
	// A privileged command is never fast-passed: `sudo npm install` may be
	// routine, but deciding that deterministically is not the gate's job.
	const privileged = /^sudo\s+/.test(s);
	const inner = privileged ? s.replace(/^sudo\s+/, "") : s;
	for (const { rule, re } of DESTRUCTIVE_SEGMENT) {
		if (re.test(inner)) return { kind: "destructive", rule };
	}
	for (const re of extra.destructive) {
		if (re.test(inner)) return { kind: "destructive", rule: `settings pattern: ${re.source}` };
	}
	const tokens = inner.split(/\s+/);
	if (recursiveChmodOnSystemRoot(tokens)) return { kind: "destructive", rule: "recursive chmod/chown on a system root" };
	if (tokens[0] === "rm") {
		const flags: string[] = [];
		const targets: string[] = [];
		for (const t of tokens.slice(1)) {
			if (t.startsWith("-") && t !== "--") flags.push(t.slice(1));
			else if (t !== "--") targets.push(t);
		}
		const joined = flags.join("");
		if (joined.includes("r") && joined.includes("f") && targets.length > 0) {
			if (targets.every((t) => DISPOSABLE_DIR.test(t))) return privileged ? { kind: "review" } : { kind: "safe" };
			if (targets.some((t) => t.startsWith("~") || t.startsWith("/") || t.startsWith("$") || t.includes("*"))) {
				return { kind: "destructive", rule: "rm -rf outside disposable build/output dirs" };
			}
		}
		return { kind: "review" };
	}
	if (privileged) return { kind: "review" };
	// Read-only segments are already vetted by the READ_ONLY_BASH allowlist.
	// This matters inside chains: `git add x && git status` was blocked because
	// only whole-command read-only checks ran before laya.
	if (READ_ONLY_BASH.test(s)) return { kind: "safe" };
	// Test, build, and check invocations write only regenerable outputs (the
	// rubric scores them LOW) but live probing (2026-09) showed laya scoring
	// plain `./test.sh` at P 0.83 anyway (the checkpoint cannot reliably follow
	// the rubric tail), so they fast-pass deterministically instead.
	if (looksLikeTestRun(s)) return { kind: "safe" };
	// Additive writes and repo-relative installs are safe fast-path segments.
	// git switch of a plain branch is safe too: it refuses to discard local
	// changes and fails on conflict, unlike checkout which can take a bare
	// pathspec.
	if (
		/^git (add|commit|tag \S+|checkout -b|switch \S+|branch (?!-D)\S+|stash (list|show)|push(?!.*(\s-f(\s|$)|--force|\s\+\S)))/.test(s) ||
		/^(mkdir|touch)\b/.test(s) ||
		/^(cp|rsync|ln)(\s+-[a-zA-Z]+)*\s+(\.\/)?[^/\s~][^\s]*/.test(s)
	) {
		return { kind: "safe" };
	}
	for (const re of extra.safe) {
		if (re.test(s)) return { kind: "safe" };
	}
	return { kind: "review" };
}

/** Whole-command verdict: destructive if any segment is, safe only when every
 * segment is, otherwise the command goes to laya for scoring. */
export function gateVerdict(segments: readonly string[], extra: ExtraGatePatterns = { safe: [], destructive: [] }): GateSegmentVerdict {
	let allSafe = true;
	for (const segment of segments) {
		const v = gateSegmentVerdict(segment, extra);
		if (v.kind === "destructive") return v;
		if (v.kind !== "safe") allSafe = false;
	}
	return allSafe ? { kind: "safe" } : { kind: "review" };
}

/** Build, dependency, and output directories that tooling regenerates on
 * demand. rm -rf of these (only) is routine, not destructive. */
const DISPOSABLE_DIR = /^(?:\.\/)?(?:build|dist|node_modules|coverage|out|tmp|temp|\.next|\.nuxt|\.turbo|\.cache|target)(?:\/|$)/;


// --- Engine reads (gate/steer/triage share these) ----------------------------

let warmedFor: string | undefined;
/** Best-effort single load of the active engine's checkpoint. Called once at
 * startup and awaited on the first agent turn if the startup prime has not
 * finished; fails silently so an unreachable server never blocks the turn.
 * Keyed by engine id + url so a mid-session engine switch re-warms. */
async function warmEngine(config: DecisionEngineConfig): Promise<void> {
	const key = `${config.id}:${config.url}`;
	if (config.unconfigured || warmedFor === key) return;
	try {
		await sys1Fetch(config, JSON.stringify({ state: "warmup", questions: { warmup: { type: "noul", instructions: "Warmup." } } }), config.warmTimeoutMs);
		warmedFor = key;
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
// After a bash tool result that looks like a failing test run, ONE System-1
// read estimates the probability that the failure was caused by the agent's
// current change. Below TRIAGE_ADVISORY_BELOW, a hidden advisory tells the
// model to verify the failure reproduces on HEAD before fixing anything. Kill
// switch: HUMMIN_SYS1_TRIAGE=off (or the legacy HUMMIN_LAYA_TRIAGE=off). Fail
// open: the read result never modifies the tool result and any error is
// swallowed.

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
 * is probably caused by the current change (no message sent). The threshold
 * comes from the active engine's config (default TRIAGE_ADVISORY_BELOW). */
export function triageAdvisory(score: number, threshold: number = TRIAGE_ADVISORY_BELOW): string | undefined {
	if (score >= threshold) return undefined;
	return `System-1 triage: this failure may pre-date your change (P(caused_by_change)=${score.toFixed(2)}). Verify it reproduces on HEAD (git status/stash or a clean checkout) before attempting fixes.`;
}

/** Pure: rate-limit decision for triage reads (at most one per window). */
export function triageRateLimited(now: number, lastReadAt: number): boolean {
	return now - lastReadAt < TRIAGE_RATE_LIMIT_MS;
}

function triageState(command: string, resultText: string): string {
	return `A coding agent ran this test command in the user's project:\n\n${command.slice(0, 500)}\n\nOutput tail:\n${resultText.slice(-TRIAGE_MAX_RESULT_CHARS)}`;
}

// --- Shared gate decision (bash hook + background shells) --------------------
//
// exec and monitor spawn shells through ProcessManager without a bash
// tool_call, so gating only the bash hook made them a standing bypass around
// the destructive-command gate. layaGateCheck is the full decision for one
// command, shared by the bash hook and by background shells via
// lib/shell-gate.ts. HUMMIN_SYS1_GATE=off (or the legacy HUMMIN_LAYA_GATE=off)
// disables it everywhere.

// The rubric below is the gate's actual quality: it is a decision spec, not
// a hint. It states the one question being decided, anchors both ends of
// the scale with concrete commands, gives the chain and unknown-command
// rules, and biases toward LOW so the gate stays a tripwire for
// recognizable destruction rather than a sandbox. Every false positive
// trains distrust of the gate; every miss is bounded by the
// confirm-marker step.
//
// Known constraint (measured 2026-09, laya 0.3.20): gate reads route to the
// english checkpoint (512-token context), so with a long command the tail
// of this rubric is truncated. That is acceptable and stable - the early
// lines carry the bias and reproduce to 4 decimals across runs - but it
// means rubric edits deep in the list may not change scores. Do not switch
// gate reads to the multilingual checkpoint: with the full rubric visible
// it saturates everything to P 0.87-0.96 and cannot discriminate. The
// deterministic classifiers above, not this prompt, carry the precision.
const GATE_STATE_PREFIX = "A coding agent is about to run this bash command in the user's project directory:\n\n";
const GATE_INSTRUCTIONS = [
	"Decide exactly one question: would running this command as-is destroy work that cannot be recovered? The noul value is P(that is true).",
	"",
	"This is a safety gate: P >= 0.75 blocks the command and interrupts the user. A false HIGH annoys the user and erodes trust in the gate; a missed true HIGH costs work but is bounded because the block reason demands confirmation. When uncertain, lean LOW.",
	"",
	"Score HIGH (>= 0.75) only for irreversibly destroying state that is NOT committed, backed up, or regenerable:",
	"- Deleting or overwriting the only copy of unique user/project data: rm -rf on source files or on a directory holding uncommitted work, mv over the only copy, truncate, dd to a file",
	"- Discarding git state that is not committed or pushed: git reset --hard, git checkout -- / restore of paths, git clean -f, git rebase, filter-repo/filter-branch, git push --force / -f, deleting a branch or stash holding unmerged work (git branch -D, git stash drop, git stash clear)",
	"- Dropping data stores: DROP DATABASE, DROP TABLE, redis FLUSHALL, rm of a database or data file. These are always HIGH.",
	"- chmod/chown -R on system roots, mkfs, writing to raw disk devices, killing processes in a way that loses their work",
	"",
	"Score LOW (<= 0.25) for everything else, explicitly including:",
	"- All reads: cat/ls/grep/find, git log/diff/show/status, gh api or gh pr view, curl GET. Pipes into head/tail/grep/sort only filter output.",
	"- Git commands that only ADD history and discard nothing: git add, git commit, git tag, git checkout -b, git switch -c, creating a branch, plain git push of a new or fast-forward ref (nothing local is lost)",
	"- cp, rsync, or ln installing project files into a config, extension, or install location: the source stays in the repo, so the overwritten target is a replaceable copy - always LOW",
	"- rm -rf of a build, dist, node_modules, coverage, cache, or output directory: those are regenerated by tooling - always LOW",
	"- Running build, test, lint, or check scripts (npm run ..., node --test, tsc, pytest, make): they write only regenerable build outputs and logs",
	"- Writes to /tmp and cache dirs; mkdir, touch, package manager installs, regenerated artifacts like lockfiles",
	"",
	"Rules:",
	"- Chain rule: for commands joined with &&, ||, ;, or |, the score is the WORST single segment, no averaging. A chain is not destructive because one path looks unfamiliar.",
	"- Recoverability tie-breaker: if the target looks committed, pushed, backed up, or regenerable from source, destruction is recoverable - score LOW.",
	"- Unknown-command rule: if you cannot tell what a command does, score LOW (<= 0.25). This gate fails open by design; it is a tripwire for recognizable destruction, not a sandbox.",
	"- Do not score based on how long or how busy the command looks. Judge consequences, not appearance.",
].join("\n");

const BLOCKED_ONCE_MAX = 200;
const blockedOnce = new Set<string>();

function rememberBlocked(command: string): void {
	blockedOnce.add(command);
	if (blockedOnce.size > BLOCKED_ONCE_MAX) {
		const oldest = blockedOnce.values().next();
		if (!oldest.done) blockedOnce.delete(oldest.value);
	}
}

const GATE_NOTIFY_THROTTLE_MS = 60_000;
let lastGateNotifyAt = 0;

/** Best-effort attention notification when the gate blocks: the agent is
 * stopped and may need the user, who is often unfocused exactly then.
 * Throttled to one per window; suppressed in headless modes by the shared
 * notification gate and by HUMMIN_NOTIFY=off. Never breaks the gate. */
function notifyGateBlock(command: string, cwd: string): void {
	try {
		const now = Date.now();
		if (now - lastGateNotifyAt < GATE_NOTIFY_THROTTLE_MS) return;
		lastGateNotifyAt = now;
		let channel: TerminalNotificationChannel = "bell";
		try {
			channel = SettingsManager.create(cwd).getTerminalNotifications();
		} catch {
			// unreadable settings: bell
		}
		sendTerminalNotification(channel, `hummin: sys1 gate blocked ${command.slice(0, 80)}`);
	} catch {
		// never break the gate over a notification
	}
}

function gateBlockReason(headline: string, repeatHint: string, repeat: boolean): string {
	return (
		`[sys1 gate] ${headline}. Do not simply retry it. Either (1) confirm with the user that the target is disposable, or (2) verify it is backed up or reproducible. Once confirmed, re-run the same command with '${GATE_CONFIRM_MARKER}' appended so the gate lets it through.` +
		(repeat
			? `\n\nThis exact command was already blocked once. Do NOT retry with variations. Use the ask_user tool to ask the user now, quoting this command and the ${repeatHint}.`
			: "")
	);
}

export interface LayaGateDecision {
	block: boolean;
	reason?: string;
}

/**
 * Full bash-gate decision for one command: confirm-marker handling, the
 * read-only fast path, deterministic destructive rules, then one System-1
 * read from the active engine for the gray zone. `sys1Read` is injectable for
 * tests; `cwd` labels the gate state. Returns undefined when the command may
 * run.
 *
 * The confirm marker authorizes a re-run only when a block of the exact same
 * command exists in the confirm window (CONFIRM_WINDOW_MS); a marker on any
 * other command is audited as an anomaly and the stripped command runs the
 * full gate. Never blocks merely because a marker was unexpected.
 */
export async function layaGateCheck(
	rawCommand: string,
	sys1Read?: (state: string, name: string, instructions: string) => Promise<{ noul: number } | null>,
	cwd: string = process.cwd(),
): Promise<LayaGateDecision | undefined> {
	const engine = resolveDecisionEngine(cwd);
	// The default read uses THIS call's engine snapshot: the block threshold,
	// the audit engine tag, and the answering endpoint must come from one
	// resolution, or a different-cwd caller (shell-gate) could threshold on
	// one project's settings while querying another's engine URL.
	const doRead = sys1Read ?? ((state: string, name: string, instructions: string) => sys1Noul(engine, state, name, instructions, engine.gateTimeoutMs));
	if (sys1Disabled("HUMMIN_SYS1_GATE", "HUMMIN_LAYA_GATE")) return undefined;
	const trimmed = rawCommand.trim();
	if (!trimmed) return undefined;
	let command = trimmed;
	if (trimmed.includes(GATE_CONFIRM_MARKER)) {
		const bare = trimmed.replace(GATE_CONFIRM_MARKER, "").trim();
		if (!bare) return undefined;
		const block = recentBlockFor(bare, Date.now());
		if (block) {
			auditGate({ type: "confirmed", command: bare, p: block.p }, engine.id);
			blockedOnce.delete(bare);
			return undefined;
		}
		auditGate({ type: "anomaly", command: bare }, engine.id);
		command = bare;
	}
	const segments = splitSegments(command);
	// hasWriteRedirect must gate the fast path too: splitSegments strips
	// redirects from segments, so without this check `echo x > important.txt`
	// passes as read-only without ever reaching the redirect downgrade below.
	if (
		segments.length > 0 &&
		segments.every((s) => READ_ONLY_BASH.test(s)) &&
		!hasWriteRedirect(command)
	)
		return undefined;
	// Deterministic verdicts first: canonical destructive commands block
	// without an engine read; fully additive commands pass without one. Only
	// the gray zone pays the engine latency. Settings extras
	// (layaGate.extraSafe / layaGate.extraDestructive regex strings) are
	// re-read per command so /settings edits apply without a restart.
	let extra: ExtraGatePatterns = { safe: [], destructive: [] };
	try {
		extra = SettingsManager.create(cwd).getLayaGateExtraPatterns();
	} catch {
		// unreadable settings: built-in lists only
	}
	let verdict = gateVerdict(segments, extra);
	// splitSegments strips redirects, so a write redirect hides from the
	// segment classifiers: `echo x > important.txt` looks read-only.
	// Downgrade safe verdicts to review so the engine sees the redirect.
	if (verdict.kind === "safe" && hasWriteRedirect(command)) verdict = { kind: "review" };
	if (verdict.kind === "destructive") {
		const repeat = blockedOnce.has(command);
		rememberBlocked(command);
		auditGate({ type: "block", command, rule: verdict.rule }, engine.id);
		notifyGateBlock(command, cwd);
		return {
			block: true,
			reason: gateBlockReason(`this command matches a known-destructive pattern (${verdict.rule})`, "rule", repeat),
		};
	}
	if (verdict.kind === "safe") {
		blockedOnce.delete(command);
		return undefined;
	}
	const read = await doRead(
		`${GATE_STATE_PREFIX}cwd: ${cwd}\n\n${command.slice(0, 1800)}`,
		"destructive",
		GATE_INSTRUCTIONS,
	);
	if (!read) return undefined;
	auditRead("gate", read.noul, engine.id);
	if (read.noul < engine.gateThreshold) {
		blockedOnce.delete(command);
		return undefined;
	}
	const repeat = blockedOnce.has(command);
	rememberBlocked(command);
	auditGate({ type: "block", command, p: read.noul }, engine.id);
	notifyGateBlock(command, cwd);
	return {
		block: true,
		reason: gateBlockReason(`the ${engine.id} engine scores this command P=${read.noul.toFixed(2)} as irreversibly destructive`, "score", repeat),
	};
}

export default function humminLaya(pi: ExtensionAPI): void {
	registerChildDispatchReviewTool(pi);
	pi.registerTool({
		name: "sys1_decide",
		label: "System-1 Decide",
		description:
			"Fast calibrated second opinion (System-1) on structured decisions: pick between named options, a yes/no judgment with P(true), or a rating on an ordinal rubric. One forward pass, no text generation, so it cannot make things up. Consult it when you are torn between options, unsure whether to proceed with a risky action, or want an independent confidence check on a decision. It cannot do open Q&A, reasoning, or more than ~20 options.",
		promptSnippet:
			"sys1_decide: ask the System-1 decision engine (laya, clef, or jev - whichever is configured) for a calibrated second opinion on a choice, yes/no gate, or rubric score before committing to a decision",
		parameters: Type.Object({
			state: Type.String({
				description:
					"The situation to decide over: the relevant facts, constraints, and the options or claim in context (max 50k chars). The engine reads only this text, so include everything the decision needs.",
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
			const engine = resolveDecisionEngine();
			if (engine.unconfigured) {
				return {
					content: [{ type: "text", text: `Error: the '${engine.id}' decision engine has no url configured. Set settings decision.${engine.id}.url or env HUMMIN_DECISION_URL, or switch engines with HUMMIN_DECISION_ENGINE=laya.` }],
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
				response = await sys1Fetch(engine, JSON.stringify({ state: params.state.slice(0, MAX_STATE_CHARS), questions }), engine.decideTimeoutMs);
			} catch (err) {
				const msg = err instanceof Error && /abort|timeout/i.test(err.message)
					? `the ${engine.id} engine did not answer within ${engine.decideTimeoutMs / 1000}s (cold checkpoint may still be loading)`
					: `the ${engine.id} engine is unreachable at ${engine.url}`;
				return {
					content: [{
						type: "text",
						text: `${msg}. Every engine serves GET /health on its port; the Mac laya instance restarts with: launchctl kickstart -k gui/501/com.hummin.laya`,
					}],
					isError: true,
					details: {},
				};
			}

			if (!response.ok) {
				const detail = (await response.text()).slice(0, 300);
				const auth = response.status === 401 && !engine.apiKey ? " (no API key is configured: set HUMMIN_DECISION_API_KEY or decision.<engine>.apiKey)" : "";
				return {
					content: [{ type: "text", text: `the ${engine.id} engine returned HTTP ${response.status}${auth}: ${detail}` }],
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
			if (isFinite(weakest)) auditRead("decide", weakest, engine.id);
			if (isFinite(weakest) && weakest < LOW_CONFIDENCE) {
				lines.push(
					`note: weakest answer confidence ${pct(weakest)} is below ${pct(LOW_CONFIDENCE)}; weigh your own judgment and the state text more than the engine here`,
				);
			}
			if (payload.routing?.model) {
				lines.push(`(sys1 engine ${engine.id}: ${payload.routing.model})`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	// Prime the active engine's checkpoint once at startup so the first real
	// call does not hit the cold prefill wall (which would exceed the request
	// timeout). Fire and forget: a dead server never blocks process start.
	void warmEngine(resolveDecisionEngine()).catch(() => undefined);

	// Per-turn steering: read the user prompt before the agent starts and, only
	// when the engine is confident the request involves destructive action,
	// inject a quiet context message steering the model to verify and confirm
	// first.
	if (!sys1Disabled("HUMMIN_SYS1_STEER", "HUMMIN_LAYA_STEER")) {
		pi.on("before_agent_start", async (event) => {
			const prompt = event.prompt.trim();
			if (prompt.length < STEER_MIN_PROMPT_CHARS || prompt.startsWith("/")) return undefined;
			const engine = resolveDecisionEngine();
			await warmEngine(engine);
			const read = await sys1Noul(
				engine,
				prompt.slice(0, 4000),
				"destructive_intent",
				"Fulfilling this request requires destructive or hard-to-reverse actions such as deleting, overwriting, force-pushing, or dropping data.",
			);
			if (read) auditRead("steer", read.noul, engine.id);
			if (!read || read.noul < engine.steerThreshold) return undefined;
			return {
				message: {
					customType: "sys1-read",
					content: `[sys1 read via ${engine.id}, P=${read.noul.toFixed(2)}] This request may require destructive or hard-to-reverse actions. Before deleting, overwriting, or dropping anything: verify the exact target, check it is backed up or reproducible, and ask the user if the scope is not explicit.`,
					display: false,
					details: {},
				},
			};
		});
	}

	if (!sys1Disabled("HUMMIN_SYS1_GATE", "HUMMIN_LAYA_GATE")) {
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const decision = await layaGateCheck(command);
			if (decision?.block) return { block: true, reason: decision.reason };
			return undefined;
		});
	}

	// Test-failure triage: after a failing test run, one System-1 read judges
	// whether the failure predates the agent's change. All failure modes fail
	// open; nothing here may throw into the tool result path.
	if (!sys1Disabled("HUMMIN_SYS1_TRIAGE", "HUMMIN_LAYA_TRIAGE")) {
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
				// Consumed on attempt, not success, so a dead engine cannot turn
				// every failing test into another timeout wait.
				lastTriageReadAt = now;
				const engine = resolveDecisionEngine();
				const read = await sys1Noul(
					engine,
					triageState(command, resultText),
					"caused_by_change",
					"Score the probability that this test failure was caused by the coding agent's current changes rather than by pre-existing breakage, flaky tests, or environment problems.",
				);
				if (!read) return;
				auditRead("triage", read.noul, engine.id);
				const advisory = triageAdvisory(read.noul, engine.triageThreshold);
				if (advisory === undefined) return;
				pi.sendMessage({ customType: "hummin-sys1-triage", content: advisory, display: false, details: {} });
			} catch {
				// Never throw into the tool result path.
			}
		});
	}

	// Model right-size gate: child dispatches (task, cron_create, scheduled cron
	// runs, memory distill/fold) are reviewed by the single call-site authority
	// prepareChildDispatch() in ./lib/child-dispatch-review.ts, which consults
	// the active System-1 engine against the live model registry, holds strong
	// disagreements behind a review receipt, and registers the
	// child_dispatch_review resolution tool (see registerChildDispatchReviewTool
	// above). This extension intentionally has no parallel tool_call gate here:
	// two gating authorities would issue competing review receipts for the same
	// dispatch.
}
