import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import {
	createExecFileHookRunner,
	ENTIRE_CONTEXT_CUSTOM_TYPE,
	findEntireSettingsDir,
	type HookRunner,
	hardenBashCommand,
	parseInjectContext,
} from "./forwarder.ts";

/**
 * Optional Entire companion: when a project is Entire-enabled (`.entire`
 * settings present) and the `entire` binary is on PATH, forwards hummin's
 * session lifecycle to `entire hooks pi <event>` so checkpoints, transcripts,
 * brain recall, and resume work for hummin sessions. Projects without Entire
 * see nothing: no hooks, no context, no egress.
 *
 * Inform, never act: this extension never runs `entire enable`, never writes
 * settings or git hooks, and never pushes. Checkpoint destinations stay under
 * the user's own Entire configuration and `git push`. `/entire` prints the
 * facts (`entire status` is offline by design). Sessions are attributed to
 * agent "pi" inside Entire until hummin is a built-in agent there.
 */
export function createEntireCompanionExtension(
	options: { hookRunner?: HookRunner; binaryProbe?: (cwd: string) => Promise<boolean> } = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const runHook = options.hookRunner?.runHook ?? createExecFileHookRunner().runHook;
		const binaryProbe =
			options.binaryProbe ??
			(async (cwd: string) => {
				try {
					const result = await pi.exec("sh", ["-c", "command -v entire"], { cwd, timeout: 10000 });
					return result.stdout.trim() !== "";
				} catch {
					return false;
				}
			});

		let binaryOnPath: boolean | undefined;
		async function isArmed(cwd: string): Promise<boolean> {
			if (!findEntireSettingsDir(cwd)) return false;
			if (binaryOnPath === undefined) binaryOnPath = await binaryProbe(cwd);
			return binaryOnPath;
		}

		// Mark this process so hummin subprocesses (subagents) know they are nested and
		// must not forward their own lifecycle as the user's session. Same marker the
		// official forwarder uses, so Entire's CLI side treats both identically. Stamped
		// only when the launch project is Entire-enabled: projects without Entire see
		// nothing, not even environment variables.
		const launchEnabled = findEntireSettingsDir(process.cwd()) !== undefined;
		const nested = launchEnabled && Boolean(process.env.ENTIRE_PI_NESTED);
		if (launchEnabled) process.env.ENTIRE_PI_NESTED = "1";

		// Bash hardening is part of the armed surface: registered per-event so a `cd`
		// into (or out of) an Entire-enabled project switches it with the session.
		// Mirrors the official forwarder, which only ever loads in enabled projects.
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "bash") return;
			if (!findEntireSettingsDir(ctx.cwd)) return;
			const input = event.input as { command?: string };
			if (typeof input.command !== "string" || input.command.includes("GIT_TERMINAL_PROMPT=")) {
				return;
			}
			input.command = hardenBashCommand(input.command);
		});

		if (nested) return;

		pi.on("session_start", async (_event, ctx) => {
			if (!(await isArmed(ctx.cwd))) return;
			await runHook("session_start", {
				type: "session_start",
				cwd: ctx.cwd,
				session_file: ctx.sessionManager.getSessionFile(),
			});
		});

		pi.on("before_agent_start", async (event, ctx) => {
			if (!(await isArmed(ctx.cwd))) return undefined;
			// Only user-initiated runs carry a prompt; custom-message runs forward without one.
			const prompt = "prompt" in event ? event.prompt : undefined;
			const stdout = await runHook("before_agent_start", {
				type: "before_agent_start",
				cwd: ctx.cwd,
				session_file: ctx.sessionManager.getSessionFile(),
				prompt,
			});
			const injected = parseInjectContext(stdout);
			if (!injected) return undefined;
			// Hidden, persistent context (brain brief/recall). display:false keeps it out of
			// the user-facing transcript while still sending it to the model. The hook output
			// is untrusted Entire output: capped so a runaway brief cannot flood the context.
			const content = injected.length <= 600 ? injected : `${injected.slice(0, 600)}\n[truncated]`;
			return { message: { customType: ENTIRE_CONTEXT_CUSTOM_TYPE, content, display: false } };
		});

		pi.on("agent_end", async (_event, ctx) => {
			if (!(await isArmed(ctx.cwd))) return;
			await runHook("agent_end", {
				type: "agent_end",
				cwd: ctx.cwd,
				session_file: ctx.sessionManager.getSessionFile(),
			});
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			if (!(await isArmed(ctx.cwd))) return;
			await runHook("session_shutdown", { type: "session_shutdown" });
		});

		pi.registerCommand("entire", {
			description: "Show Entire integration facts for this project",
			category: "Tools",
			handler: async (_args, ctx) => {
				const settingsDir = findEntireSettingsDir(ctx.cwd);
				if (!settingsDir) {
					ctx.ui.notify(
						`Entire is not enabled here: no .entire/settings found from ${ctx.cwd} up the tree. Nothing is armed, nothing is sent.`,
						"info",
					);
					return;
				}
				const armed = await isArmed(ctx.cwd);
				let status = "";
				try {
					const result = await pi.exec("entire", ["status"], { cwd: settingsDir, timeout: 10000 });
					status = result.stdout.trim();
				} catch {
					status = "(entire status failed to run)";
				}
				const lines = [
					armed
						? 'Entire companion armed: session lifecycle forwards to `entire hooks pi` (sessions are labeled agent "pi" inside Entire).'
						: "Entire settings found, but the `entire` binary is not on PATH: forwarding is off.",
					`Settings dir: ${settingsDir}`,
					status ? `entire status (offline command):\n${status}` : "",
					"Facts: checkpoint refs ride your own `git push` per Entire's destination policy; session copies persist unredacted under .entire/metadata until cleaned. See docs/reference/entire.md.",
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n\n"), "info");
			},
		});
	};
}

export default createEntireCompanionExtension();
