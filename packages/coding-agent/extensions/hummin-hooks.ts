import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProcessManager } from "./lib/processes.ts";

// ============================================================================
// Pure helpers (unit tested in test/hooks-config.test.ts)
// ============================================================================

export const HOOK_EVENTS = ["tool_call", "tool_result", "agent_start", "agent_end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;

export interface HookEntry {
	event: HookEvent;
	/** Tool name glob (only meaningful for tool_call). Undefined matches everything. */
	matcher: string | undefined;
	command: string;
	timeoutMs: number;
	/** Path of the hooks.json this entry came from. */
	source: string;
}

/** Translate a glob (`*` = any run, `?` = any char) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (const char of glob) {
		if (char === "*") pattern += "[\\s\\S]*";
		else if (char === "?") pattern += "[\\s\\S]";
		else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`);
}

/** Does this entry apply to the given tool name? */
export function hookMatches(entry: Pick<HookEntry, "matcher">, toolName: string): boolean {
	if (!entry.matcher) return true;
	return globToRegExp(entry.matcher).test(toolName);
}

/** Clamp a configured timeout: invalid/missing -> default, hard cap 60s. */
export function capTimeout(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
	return Math.min(Math.floor(value), MAX_HOOK_TIMEOUT_MS);
}

export class HookConfigError extends Error {}

function parseEntry(event: HookEvent, raw: unknown, source: string, index: number): HookEntry {
	if (typeof raw !== "object" || raw === null) {
		throw new HookConfigError(`${source}: hooks.${event}[${index}] must be an object`);
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.command !== "string" || !record.command.trim()) {
		throw new HookConfigError(`${source}: hooks.${event}[${index}].command must be a non-empty string`);
	}
	if (record.matcher !== undefined && typeof record.matcher !== "string") {
		throw new HookConfigError(`${source}: hooks.${event}[${index}].matcher must be a string`);
	}
	if (record.timeout_ms !== undefined && (typeof record.timeout_ms !== "number" || record.timeout_ms <= 0)) {
		throw new HookConfigError(`${source}: hooks.${event}[${index}].timeout_ms must be a positive number`);
	}
	return {
		event,
		matcher: record.matcher,
		command: record.command,
		timeoutMs: capTimeout(record.timeout_ms),
		source,
	};
}

/** Parse and validate a hooks.json document. Throws HookConfigError on any problem. */
export function parseHooksConfig(text: string, source: string): HookEntry[] {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (error) {
		throw new HookConfigError(`${source}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		throw new HookConfigError(`${source}: top level must be an object`);
	}
	const hooks = (document as Record<string, unknown>).hooks;
	if (hooks === undefined) return [];
	if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
		throw new HookConfigError(`${source}: "hooks" must be an object`);
	}
	const entries: HookEntry[] = [];
	for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
			throw new HookConfigError(`${source}: unknown hook event "${event}" (expected one of ${HOOK_EVENTS.join(", ")})`);
		}
		if (!Array.isArray(list)) {
			throw new HookConfigError(`${source}: hooks.${event} must be an array`);
		}
		list.forEach((raw, index) => entries.push(parseEntry(event as HookEvent, raw, source, index)));
	}
	return entries;
}

export interface BlockDecision {
	block: boolean;
	reason?: string;
}

/** Find the last complete JSON object in mixed stdout/stderr text. */
export function lastJsonObject(text: string): unknown {
	const spans: Array<[number, number]> = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			if (depth > 0) inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth++;
		} else if (char === "}") {
			if (depth === 0) continue;
			depth--;
			if (depth === 0 && start >= 0) {
				spans.push([start, index + 1]);
				start = -1;
			}
		}
	}
	for (let index = spans.length - 1; index >= 0; index--) {
		const [from, to] = spans[index]!;
		try {
			return JSON.parse(text.slice(from, to));
		} catch {
			// Not valid JSON; keep looking backwards.
		}
	}
	return undefined;
}

/**
 * Extract the hook's block decision from process output. Returns undefined when
 * the output contains no usable decision (non-JSON or empty stdout is ignored).
 */
export function extractBlockDecision(output: string): BlockDecision | undefined {
	const parsed = lastJsonObject(output);
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.block !== "boolean") return undefined;
	const decision: BlockDecision = { block: record.block };
	if (typeof record.reason === "string") decision.reason = record.reason;
	return decision;
}

/** Single-quote a string for POSIX shells. */
export function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the zsh command that feeds event JSON on the child's stdin to the user
 * command. ProcessManager spawns with stdin ignored, so the pipe is created
 * inside the shell; the user command still reads the event from stdin.
 */
export function buildShellCommand(command: string, eventJson: string): string {
	return `printf '%s' ${shQuote(eventJson)} | (${command})`;
}

/** Session env the hook command sees, mirroring what bash tools get. */
export function buildHookEnv(
	ctx: Pick<ExtensionContext, "sessionManager" | "model" | "thinkingLevel">,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { HUMMIN_MEMORY: "0" };
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

/** Pad a cell to the column width, with one space of gutter. */
function cell(text: string, width: number): string {
	const padding = Math.max(1, width - text.length + 1);
	return text + " ".repeat(padding);
}

/** Render the /hooks table (/doctor style): event, matcher, command, source, timeout. */
export function formatHooksTable(entries: readonly HookEntry[]): string {
	if (entries.length === 0) return "No hooks loaded (global: ~/.hummin/agent/hooks.json, project: .hummin/hooks.json)";
	const header = { event: "EVENT", matcher: "MATCHER", command: "COMMAND", source: "SOURCE", timeout: "TIMEOUT" };
	const rows = entries.map((entry) => ({
		event: entry.event,
		matcher: entry.matcher ?? "*",
		command: entry.command,
		source: entry.source,
		timeout: `${entry.timeoutMs}ms`,
	}));
	const widths = {
		event: header.event.length,
		matcher: header.matcher.length,
		command: header.command.length,
		source: header.source.length,
		timeout: header.timeout.length,
	};
	for (const row of rows) {
		widths.event = Math.max(widths.event, row.event.length);
		widths.matcher = Math.max(widths.matcher, row.matcher.length);
		widths.command = Math.max(widths.command, row.command.length);
		widths.source = Math.max(widths.source, row.source.length);
		widths.timeout = Math.max(widths.timeout, row.timeout.length);
	}
	const render = (row: { event: string; matcher: string; command: string; source: string; timeout: string }): string =>
		`${cell(row.event, widths.event)}${cell(row.matcher, widths.matcher)}${cell(row.command, widths.command)}${cell(
			row.source,
			widths.source,
		)}${cell(row.timeout, widths.timeout)}`;
	const divider = "-".repeat(render(rows[0]!).length);
	return [render(header), divider, ...rows.map(render)].join("\n");
}

// ============================================================================
// Extension
// ============================================================================

interface EventPayload {
	event: HookEvent;
	timestamp: number;
	cwd: string;
	tool_name?: string;
	tool_call_id?: string;
	input?: unknown;
	is_error?: boolean;
}

export default function humminHooks(pi: ExtensionAPI): void {
	const manager = new ProcessManager(join(getAgentDir(), "hook-runs"), "hook");
	let entries: HookEntry[] = [];
	let inHook = false;
	let closed = false;
	/** Keys whose failure already produced a notification (one-time, fail-open). */
	const notifiedFailures = new Set<string>();

	function load(ctx: ExtensionContext): { loaded: number; problems: string[] } {
		const problems: string[] = [];
		const loaded: HookEntry[] = [];
		const files: Array<{ path: string; trusted: boolean }> = [
			{ path: join(getAgentDir(), "hooks.json"), trusted: true },
			{ path: join(ctx.cwd, ".hummin", "hooks.json"), trusted: ctx.isProjectTrusted() },
		];
		for (const file of files) {
			let text: string;
			try {
				text = readFileSync(file.path, "utf8");
			} catch {
				continue;
			}
			if (!file.trusted) {
				problems.push(`Project hooks require trust: ${file.path} (use /trust)`);
				continue;
			}
			try {
				loaded.push(...parseHooksConfig(text, file.path));
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}
		entries = loaded;
		return { loaded: loaded.length, problems };
	}

	/** Run every matching hook for an event. Returns blocking decisions (tool_call only). */
	async function runHooks(
		event: HookEvent,
		payload: Omit<EventPayload, "event" | "timestamp" | "cwd">,
		ctx: ExtensionContext,
	): Promise<BlockDecision[]> {
		// No recursion: never react to events while a hook command itself is running.
		if (closed || inHook) return [];
		const matching = entries.filter((entry) => entry.event === event && hookMatches(entry, payload.tool_name ?? ""));
		if (matching.length === 0) return [];
		inHook = true;
		const decisions: BlockDecision[] = [];
		try {
			const full: EventPayload = { ...payload, event, timestamp: Date.now(), cwd: ctx.cwd };
			const env = buildHookEnv(ctx);
			for (const entry of matching) {
				if (closed) break;
				const decision = await runHookEntry(entry, full, env, ctx);
				if (decision) decisions.push(decision);
			}
		} finally {
			inHook = false;
		}
		return decisions;
	}

	async function runHookEntry(
		entry: HookEntry,
		payload: EventPayload,
		env: NodeJS.ProcessEnv,
		ctx: ExtensionContext,
	): Promise<BlockDecision | undefined> {
		const command = buildShellCommand(entry.command, JSON.stringify(payload));
		let job;
		try {
			job = manager.start({
				command: "/bin/zsh",
				args: ["-lc", command],
				cwd: ctx.cwd,
				kind: "hook",
				label: `${entry.event}: ${entry.command.slice(0, 80)}`,
				timeoutMs: entry.timeoutMs,
				env,
			});
		} catch (error) {
			notifyOnce(ctx, `start:${entry.command}`, `[Hooks] failed to start (${entry.command}): ${String(error)}`);
			return undefined;
		}
		await job.done;
		if (job.exitCode !== 0) {
			notifyOnce(
				ctx,
				`fail:${entry.source}:${entry.command}`,
				`[Hooks] exited ${job.exitCode ?? "abnormally"}, ignored: ${entry.command}`,
			);
			return undefined;
		}
		return extractBlockDecision(job.output);
	}

	function notifyOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (notifiedFailures.has(key)) return;
		notifiedFailures.add(key);
		ctx.ui.notify(message, "warning");
	}

	pi.on("session_start", (_event, ctx) => {
		const { problems } = load(ctx);
		for (const problem of problems) ctx.ui.notify(problem, "warning");
	});

	pi.on("tool_call", async (event, ctx) => {
		const decisions = await runHooks(
			"tool_call",
			{ tool_name: event.toolName, tool_call_id: event.toolCallId, input: event.input },
			ctx,
		);
		const blocked = decisions.find((decision) => decision.block);
		if (blocked) return { block: true, reason: blocked.reason };
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		await runHooks(
			"tool_result",
			{ tool_name: event.toolName, tool_call_id: event.toolCallId, input: event.input, is_error: event.isError },
			ctx,
		);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await runHooks("agent_start", {}, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await runHooks("agent_end", {}, ctx);
	});

	pi.registerCommand("hooks", {
		description: "Show loaded hooks (/hooks); reload hooks.json (/hooks reload)",
		async handler(args, ctx) {
			if (args.trim().toLowerCase() === "reload") {
				const { loaded, problems } = load(ctx);
				for (const problem of problems) ctx.ui.notify(problem, "warning");
				ctx.ui.notify(`[Hooks] loaded ${loaded} hook${loaded === 1 ? "" : "s"}`, "info");
			}
			ctx.ui.notify(formatHooksTable(entries), "info");
		},
	});

	pi.on("session_shutdown", async () => {
		closed = true;
		entries = [];
		await manager.close();
	});
}
