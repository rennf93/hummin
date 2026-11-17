/**
 * Forwarder logic for the Entire companion extension.
 *
 * Mirrors Entire's official pi integration (`entire agent add pi` -> the project's
 * `.pi/extensions/entire/index.ts`): the same JSON payloads go to
 * `entire hooks pi <event>`, and the hook's `inject_context` envelope (brain
 * brief/recall) comes back as a hidden custom message. Everything is
 * best-effort: a failing hook resolves empty and never blocks the agent.
 *
 * Discovery is location-agnostic on purpose: Entire reads the transcript from
 * the `session_file` path the event carries, so sessions live wherever hummin
 * keeps them. Nothing here writes settings, hooks, or git state.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const ENTIRE_CONTEXT_CUSTOM_TYPE = "entire-context";

/** The project root that owns `.entire/settings(.local).json`, walking up from cwd. */
export function findEntireSettingsDir(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (
			existsSync(join(dir, ".entire", "settings.json")) ||
			existsSync(join(dir, ".entire", "settings.local.json"))
		) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Extract Entire's injection envelope from hook stdout, or null. */
export function parseInjectContext(stdout: string): string | null {
	if (!stdout) return null;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed) as { inject_context?: unknown };
			if (typeof parsed.inject_context === "string" && parsed.inject_context.length > 0) {
				return parsed.inject_context;
			}
		} catch {
			// not our envelope - ignore
		}
	}
	return null;
}

/**
 * Agent-driven bash subprocesses inherit a real TTY but cannot answer hook
 * prompts, so Entire treats agent-driven commits as non-interactive.
 */
export function hardenBashCommand(command: string): string {
	if (command.includes("GIT_TERMINAL_PROMPT=")) return command;
	return `export GIT_TERMINAL_PROMPT=0\n${command}`;
}

export interface HookRunner {
	/** Pipe a JSON payload to `entire hooks pi <hookName>`; resolves stdout ("" on any failure). */
	runHook(hookName: string, payload: Record<string, unknown>): Promise<string>;
}

export function createExecFileHookRunner(): HookRunner {
	return {
		runHook(hookName, payload) {
			return new Promise((resolvePromise) => {
				try {
					const child = execFile(
						"sh",
						["-c", `entire hooks pi ${hookName}`],
						{ timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
						(_err, stdout) => resolvePromise(typeof stdout === "string" ? stdout : ""),
					);
					child.stdin?.end(JSON.stringify(payload));
				} catch {
					resolvePromise("");
				}
			});
		},
	};
}
