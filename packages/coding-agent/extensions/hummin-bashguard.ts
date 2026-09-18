/**
 * hummin-bashguard: pre-execution bash advisory layer (Slice 13, bash
 * validation matrix). Complements hummin-sandbox (filesystem/network
 * enforcement); bashguard classifies the command TEXT before it runs.
 *
 * Checks, all pure and exported for testing:
 * - destructiveCommandWarning: rm -rf /, rm -rf ~, git reset --hard,
 *   git push --force to main/master, chmod -R 777 /, mkfs*, dd of=/dev/*
 *   -> warning notice `[BashGuard] <what> detected - confirm this is intended`
 * - sedValidation: sed -i on files outside the working directory -> warning
 * - pathValidation: writes (> >| >> tee dd cp mv) targeting outside the
 *   working directory -> info-level notice only
 * - readOnlyMode: when `bashguard.readOnly: true`, mutating commands are
 *   DENIED with `[BashGuard] read-only mode` (fail-closed for mutations)
 *
 * Delivery model: this extension does NOT override the bash tool (that is
 * hummin-sandbox's job). The tool_call handler classifies and either blocks
 * (only when a hard rule matches AND `bashguard.block: true`, or always in
 * read-only mode) or records an advisory. Advisories must reach the model,
 * so they are appended in-band to the bash tool result content via the
 * tool_result handler - the same mechanism hummin-guardrails uses for
 * budget reminders. tool_callId correlates call -> result.
 *
 * Tokenizer limits (documented deliberately): a conservative quote-aware
 * split - whitespace outside single/double quotes, quotes stripped, and
 * shell operators (> >> >| ; && ||) recognized only when unquoted. No full
 * shell grammar: command substitution, heredocs, process substitution,
 * variable expansion at runtime, and `eval` indirection are NOT analyzed.
 * A command designed to evade the tokenizer will pass unchecked; this layer
 * is advisory, not a security boundary.
 *
 * Config: settings `bashguard: { block?: boolean, readOnly?: boolean,
 * exempt?: string[] }` (exempt = regex strings; a match against the raw
 * command skips ALL checks). Env `HUMMIN_BASHGUARD=0` disables the
 * extension entirely. Precedence: env > project settings > global settings
 * > defaults (block: false, readOnly: false, exempt: []).
 *
 * `/bashguard` shows a status table and reloads settings.
 */

import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export interface BashguardConfig {
	block: boolean;
	readOnly: boolean;
	exempt: RegExp[];
	exemptRaw: string[];
}

export const DEFAULT_BASHGUARD_CONFIG: BashguardConfig = {
	block: false,
	readOnly: false,
	exempt: [],
	exemptRaw: [],
};

function readBashguardNamespace(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	return (raw as Record<string, unknown>).bashguard;
}

/** Compile an exempt regex string; invalid patterns are skipped (fail-open). */
export function compileExempt(patterns: readonly unknown[]): { regexes: RegExp[]; raw: string[] } {
	const regexes: RegExp[] = [];
	const raw: string[] = [];
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		raw.push(pattern);
		try {
			regexes.push(new RegExp(pattern));
		} catch {
			// invalid regex: skip, never block startup
		}
	}
	return { regexes, raw };
}

export function parseBashguardNamespace(raw: unknown): Partial<Pick<BashguardConfig, "block" | "readOnly">> & { exempt?: RegExp[]; exemptRaw?: string[] } {
	if (typeof raw !== "object" || raw === null) return {};
	const obj = raw as Record<string, unknown>;
	const out: ReturnType<typeof parseBashguardNamespace> = {};
	if (typeof obj.block === "boolean") out.block = obj.block;
	if (typeof obj.readOnly === "boolean") out.readOnly = obj.readOnly;
	if (Array.isArray(obj.exempt)) {
		const compiled = compileExempt(obj.exempt);
		out.exempt = compiled.regexes;
		out.exemptRaw = compiled.raw;
	}
	return out;
}

/** Resolve active config: env HUMMIN_BASHGUARD > project > global > defaults. */
export function resolveBashguardConfig(
	env: Readonly<Record<string, string | undefined>>,
	globalRaw: unknown,
	projectRaw: unknown,
): BashguardConfig {
	const global = parseBashguardNamespace(readBashguardNamespace(globalRaw));
	const project = parseBashguardNamespace(readBashguardNamespace(projectRaw));
	const exemptRaw = project.exemptRaw ?? global.exemptRaw ?? DEFAULT_BASHGUARD_CONFIG.exemptRaw;
	const exempt = project.exempt ?? global.exempt ?? DEFAULT_BASHGUARD_CONFIG.exempt;
	const config: BashguardConfig = {
		block: project.block ?? global.block ?? DEFAULT_BASHGUARD_CONFIG.block,
		readOnly: project.readOnly ?? global.readOnly ?? DEFAULT_BASHGUARD_CONFIG.readOnly,
		exempt,
		exemptRaw,
	};
	if (env.HUMMIN_BASHGUARD === "0") {
		return { ...DEFAULT_BASHGUARD_CONFIG };
	}
	return config;
}

// ---------------------------------------------------------------------------
// Conservative tokenizer (quote-aware split; limits documented in header)
// ---------------------------------------------------------------------------

export interface TokenizedCommand {
	/** Split, quote-stripped tokens. */
	tokens: string[];
	/** True when the raw command contains an unquoted `>`, `>>` or `>|` followed by a target. */
	hasWriteRedirection: boolean;
	/** True when the raw command contains an unquoted `;`, `&&` or `||`. */
	hasSequenceOperator: boolean;
}

/** Quote-aware, conservative tokenization. See module header for limits. */
export function tokenize(raw: string): TokenizedCommand {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	const flush = () => {
		if (current.length > 0) tokens.push(current);
		current = "";
	};
	let i = 0;
	while (i < raw.length) {
		const ch = raw[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < raw.length) {
			current += raw[i + 1];
			i += 2;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n") {
			flush();
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	flush();
	const stripped = stripQuoted(raw);
	return {
		tokens,
		hasWriteRedirection: /(^|[\s;])>{1,2}\|?\s*\S/.test(stripped),
		hasSequenceOperator: /;|[|&]{2}/.test(stripped),
	};
}

/** Raw command with quoted regions replaced by spaces (operator scanning). */
function stripQuoted(raw: string): string {
	let out = "";
	let quote: '"' | "'" | undefined;
	for (const ch of raw) {
		if (quote) {
			if (ch === quote) quote = undefined;
			out += " ";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += " ";
			continue;
		}
		out += ch;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Path helpers (conservative lexical checks, no fs access)
// ---------------------------------------------------------------------------

function isInsidePath(target: string, cwd: string): boolean {
	if (target === cwd) return true;
	if (target.startsWith("~")) return false; // home writes are outside the project
	const resolved = resolveLexical(target.startsWith("/") ? target : `${cwd}/${target}`);
	return resolved === cwd || resolved.startsWith(`${cwd}/`);
}

/** Resolve `.` and `..` lexically on an absolute path. */
function resolveLexical(p: string): string {
	const parts: string[] = [];
	for (const part of p.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** True when the token looks like a filesystem path (not a bare flag/word). */
function looksLikePath(token: string): boolean {
	if (token.startsWith("-")) return false;
	return token.startsWith("/") || token.startsWith("~") || token.includes("/") || token.includes("..");
}

// ---------------------------------------------------------------------------
// Check 1: destructive commands (hard rules)
// ---------------------------------------------------------------------------

/** Protected branches for force-push: main, master. */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Hard-rule classifier. Returns the warning text for the FIRST matching
 * rule, or undefined. Wording: `[BashGuard] <what> detected - confirm this
 * is intended`.
 */
export function destructiveCommandWarning(raw: string, cwd: string): string | undefined {
	const { tokens } = tokenize(raw);
	const has = (...needles: readonly string[]): boolean => tokens.some((t) => needles.includes(t));

	// rm -rf / or ~
	if (tokens[0] === "rm" || tokens.includes("rm")) {
		const rmIdx = tokens.indexOf("rm");
		const rest = tokens.slice(rmIdx + 1);
		const recursive = rest.some((t) => /^-[a-zA-Z]*r[a-zA-Z]*$/i.test(t));
		if (recursive) {
			const targets = rest.filter((t) => !t.startsWith("-"));
			for (const target of targets) {
				if (target === "/" || target === "~" || target === "$HOME" || target === "/*" || target === "~/*") {
					return `[BashGuard] rm -rf ${target} detected - confirm this is intended`;
				}
			}
		}
	}

	// git reset --hard
	if (has("git") && has("reset") && has("--hard")) {
		return "[BashGuard] git reset --hard detected - confirm this is intended";
	}

	// git push --force to a protected branch, or any push that deletes one
	if (has("git") && has("push")) {
		const forced = has("--force", "-f") || tokens.some((t) => t.startsWith("--force"));
		const branches = tokens.filter((t) => PROTECTED_BRANCHES.includes(t));
		const refspecs = tokens.filter((t) => t.includes(":") && !t.startsWith("-"));
		const deletesProtected = refspecs.some((r) => {
			const branch = r.slice(r.lastIndexOf(":") + 1);
			return PROTECTED_BRANCHES.some((b) => branch === b || branch.endsWith(`/${b}`));
		});
		const pushIdx = tokens.indexOf("push");
		const forceAfterBranch = tokens.slice(pushIdx + 1).some((t) => PROTECTED_BRANCHES.includes(t));
		if ((forced && (branches.length > 0 || forceAfterBranch)) || deletesProtected) {
			return "[BashGuard] git push --force to a protected branch (main/master) detected - confirm this is intended";
		}
	}

	// chmod -R 777 /
	if (tokens.includes("chmod")) {
		const chmodIdx = tokens.indexOf("chmod");
		const rest = tokens.slice(chmodIdx + 1);
		const recursive = rest.some((t) => /^-[a-zA-Z]*[Rr][a-zA-Z]*$/.test(t));
		const modeIdx = rest.findIndex((t) => /^[0-7]{3,4}$/.test(t));
		const mode = modeIdx >= 0 ? rest[modeIdx] : undefined;
		const target = rest.slice(modeIdx + 1).find((t) => !t.startsWith("-"));
		if (recursive && (mode === "777" || mode === "0777") && target !== undefined && !isInsidePath(target === "~" ? "~" : target, cwd)) {
			return `[BashGuard] chmod -R 777 ${target} detected - confirm this is intended`;
		}
	}

	// mkfs (mkfs, mkfs.ext4, ...)
	if (tokens.some((t) => t === "mkfs" || t.startsWith("mkfs."))) {
		return "[BashGuard] mkfs detected - confirm this is intended";
	}

	// dd of=/dev/*
	if (tokens.some((t) => /^of=\/dev\//.test(t))) {
		const ofTarget = tokens.find((t) => /^of=\/dev\//.test(t));
		return `[BashGuard] dd writing to ${ofTarget?.slice(3)} detected - confirm this is intended`;
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Check 2: sed -i outside cwd
// ---------------------------------------------------------------------------

/**
 * Warn when sed runs with in-place mode (-i / --in-place) and an operand
 * that looks like a path resolves outside the working directory.
 */
export function sedValidation(raw: string, cwd: string): string | undefined {
	const { tokens } = tokenize(raw);
	const sedIdx = tokens.indexOf("sed");
	if (sedIdx === -1) return undefined;
	const rest = tokens.slice(sedIdx + 1);
	const inPlace = rest.some((t) => t === "-i" || t === "--in-place");
	if (!inPlace) return undefined;
	// Operands after flags: the script expression and the files. Conservative:
	// flag only tokens that look like filesystem paths outside cwd. Temp paths
	// are exempt.
	for (const token of rest) {
		if (token.startsWith("-")) continue;
		if (!looksLikePath(token)) continue;
		if (token.startsWith("/tmp/") || token.startsWith("$TMPDIR")) continue;
		if (!isInsidePath(token, cwd)) {
			return `[BashGuard] sed -i modifies ${token} outside the working directory - confirm this is intended`;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Check 3: write targets outside cwd (info-level)
// ---------------------------------------------------------------------------

/**
 * Info-level notice when the command writes outside the working directory
 * via redirection (> >| >>), tee, dd of=, or cp/mv with a destination
 * outside cwd. Never blocks, never escalates.
 */
export function pathValidation(raw: string, cwd: string): string | undefined {
	const { tokens } = tokenize(raw);
	const targets: string[] = [];

	// Redirection targets appear as their own token after tokenization only if
	// whitespace-separated (" > file"). Attached forms (">file") need the raw
	// scan below.
	const stripped = stripQuoted(raw);
	for (const match of stripped.matchAll(/>{1,2}\|?\s*(\S+)/g)) {
		targets.push(match[1]);
	}
	// Attached form: >file, >>file, >|file
	for (const match of stripped.matchAll(/(?:^|[\s;])>{1,2}\|?(\S+)/g)) {
		targets.push(match[1]);
	}

	// tee targets: every non-flag operand
	if (tokens.includes("tee")) {
		const teeIdx = tokens.indexOf("tee");
		for (const token of tokens.slice(teeIdx + 1)) {
			if (!token.startsWith("-") && token !== "|") targets.push(token);
		}
	}

	// dd of=
	for (const token of tokens) {
		const ofMatch = token.match(/^of=(\S+)$/);
		if (ofMatch) targets.push(ofMatch[1]);
	}

	// cp/mv destination = last non-flag operand
	for (const verb of ["cp", "mv"] as const) {
		if (!tokens.includes(verb)) continue;
		const verbIdx = tokens.indexOf(verb);
		const operands = tokens.slice(verbIdx + 1).filter((t) => !t.startsWith("-"));
		const dest = operands[operands.length - 1];
		if (dest !== undefined) targets.push(dest);
	}

	const outside = targets.filter(
		(t) => t !== undefined && looksLikePath(t) && !t.startsWith("-") && !t.startsWith("/dev/null") && !isInsidePath(t, cwd),
	);
	if (outside.length === 0) return undefined;
	const unique = [...new Set(outside)];
	return `[BashGuard] note: this command writes outside the working directory (${unique.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Check 4: read-only mode (deny list, fail-closed for mutations)
// ---------------------------------------------------------------------------

const READ_ONLY_VERBS: readonly string[] = ["rm", "mv", "dd", "mkfs", "chmod", "chown"];

/**
 * Read-only deny decision. Returns the block reason or undefined.
 * Mutating commands: write redirections, rm/mv/dd/mkfs/chmod/chown,
 * git push/reset/clean, npm publish.
 */
export function readOnlyDeny(raw: string, cwd: string): { reason: string } | undefined {
	const { tokens, hasWriteRedirection } = tokenize(raw);
	const has = (...needles: readonly string[]): boolean => tokens.some((t) => needles.includes(t));

	const deny = (what: string): { reason: string } => ({
		reason: `[BashGuard] read-only mode: ${what} is a mutating command - denied. Set bashguard.readOnly: false to allow it.`,
	});

	if (hasWriteRedirection && writesToPath(raw)) return deny("a write redirection");
	if (READ_ONLY_VERBS.some((verb) => tokens.some((t) => t === verb || t.startsWith(`${verb}.`)))) {
		return deny(tokens.find((t) => READ_ONLY_VERBS.includes(t)) ?? "a mutating command");
	}
	if (has("git") && has("push", "reset", "clean")) return deny("git mutation");
	if (has("npm") && has("publish")) return deny("npm publish");
	if (sedInPlace(tokens)) return deny("sed -i");
	if (pathValidation(raw, cwd) !== undefined) return deny("a write outside the working directory");
	return undefined;
}

function sedInPlace(tokens: readonly string[]): boolean {
	const sedIdx = tokens.indexOf("sed");
	if (sedIdx === -1) return false;
	return tokens.slice(sedIdx + 1).some((t) => t === "-i" || t === "--in-place");
}

/** Heuristic: does an unquoted redirection actually target a writable file path? */
function writesToPath(raw: string): boolean {
	const stripped = stripQuoted(raw);
	const match = stripped.match(/(^|[\s;])>{1,2}\|?\s*(\S+)/);
	if (!match) return false;
	return !match[2].startsWith("/dev/null");
}

// ---------------------------------------------------------------------------
// Classification pipeline
// ---------------------------------------------------------------------------

export type BashguardDecision =
	| { action: "allow" }
	| { action: "block"; reason: string }
	| { action: "advise"; notice: string };

/**
 * Full classification for one bash command. Priority:
 * 1. exempt regex match -> allow (skip everything)
 * 2. read-only deny -> block
 * 3. destructive hard rule + block:true -> block; with block:false -> advise
 * 4. sed warning / path info -> advise (combined when both fire)
 */
export function classifyCommand(raw: string, cwd: string, config: BashguardConfig): BashguardDecision {
	if (config.exempt.some((re) => re.test(raw))) return { action: "allow" };

	const readOnly = config.readOnly ? readOnlyDeny(raw, cwd) : undefined;
	if (readOnly) return { action: "block", reason: readOnly.reason };

	const destructive = destructiveCommandWarning(raw, cwd);
	if (destructive) {
		return config.block ? { action: "block", reason: destructive } : { action: "advise", notice: destructive };
	}

	const notices: string[] = [];
	const sed = sedValidation(raw, cwd);
	if (sed) notices.push(sed);
	const path = pathValidation(raw, cwd);
	if (path) notices.push(path);
	if (notices.length > 0) return { action: "advise", notice: notices.join("\n") };

	return { action: "allow" };
}

// ---------------------------------------------------------------------------
// Status table
// ---------------------------------------------------------------------------

/** /doctor-style aligned two-column table text. */
export function formatBashguardTable(rows: ReadonlyArray<readonly [string, string]>): string {
	const width = Math.max(...rows.map(([k]) => k.length));
	return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

function settingsToRaw(settings: SettingsManager): { global: unknown; project: unknown } {
	return {
		global: settings.getGlobalSettings() as unknown as Record<string, unknown>,
		project: settings.getProjectSettings() as unknown as Record<string, unknown>,
	};
}

export default function humminBashguard(pi: ExtensionAPI): void {
	if (process.env.HUMMIN_BASHGUARD === "0") {
		return;
	}
	let settings = SettingsManager.create(process.cwd());

	const configNow = (): BashguardConfig => {
		const { global, project } = settingsToRaw(settings);
		return resolveBashguardConfig(process.env, global, project);
	};

	// Advisory text pending delivery, keyed by toolCallId (tool_call -> tool_result).
	const pendingAdvisories = new Map<string, string>();

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || command.trim() === "") return;
		const decision = classifyCommand(command, process.cwd(), configNow());
		if (decision.action === "allow") return;
		if (decision.action === "block") {
			return { block: true, reason: decision.reason };
		}
		pendingAdvisories.set(event.toolCallId, decision.notice);
		return undefined;
	});

	// In-band advisory delivery: append to the bash tool result content, the
	// same mechanism hummin-guardrails uses for budget reminders.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return;
		const notice = pendingAdvisories.get(event.toolCallId);
		if (notice === undefined) return;
		pendingAdvisories.delete(event.toolCallId);
		event.content.push({ type: "text", text: notice });
	});

	pi.registerCommand("bashguard", {
		description: "Show hummin bashguard status and reload settings",
		category: "Sandbox",
		handler: async (_args, ctx: ExtensionContext) => {
			const config = configNow();
			const table = formatBashguardTable([
				["block (hard rules)", String(config.block)],
				["readOnly", String(config.readOnly)],
				["exempt", config.exemptRaw.length > 0 ? config.exemptRaw.join(", ") : "-"],
				["env override", process.env.HUMMIN_BASHGUARD ?? "-"],
			] as const);
			ctx.ui.notify(`[BashGuard] status\n${table}`, "info");
			const choice = await ctx.ui.select("BashGuard", ["Reload settings", "Close"]);
			if (choice !== undefined && choice === "Reload settings") {
				settings = SettingsManager.create(process.cwd());
				ctx.ui.notify("[BashGuard] settings reloaded.", "info");
			}
		},
	});
}
