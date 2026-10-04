/**
 * One gate for every shell hummin spawns.
 *
 * The bash tool is gated by tool_call hooks (bashguard, sandbox, sys1 gate),
 * but exec and monitor spawn their shells through ProcessManager directly.
 * That made them a standing bypass around bashguard advisories and the sys1
 * destructive gate (and around the sandbox wrapper, handled separately below).
 * gateBackgroundShell composes the same classification pipeline for background
 * shells: bashguard classification first (matching tool_call hook order), then
 * the sys1 gate. Plan mode blocks the exec/cron tools at the tool_call layer.
 */
import { bashguardConfigFor, classifyCommand, type BashguardConfig } from "../hummin-bashguard.ts";
import { sys1GateCheck } from "../hummin-sys1.ts";

export interface BackgroundShellGate {
	/** Block reason; present when the command must not run. */
	blocked?: string;
	/** In-band advisory for a command that is allowed to run. */
	advisory?: string;
}

export interface ShellGateDeps {
	/** Injectable sys1 gate for tests; default is the real shared gate. */
	sys1Check?: typeof sys1GateCheck;
	/** Injectable bashguard config for tests; default resolves from settings. */
	bashguardConfig?: BashguardConfig;
}

/**
 * Full gate decision for a command an exec/monitor tool is about to spawn.
 * Never throws: an unavailable layer degrades the way the bash hooks do
 * (bashguard config falls back to defaults, the sys1 gate fails open).
 */
export async function gateBackgroundShell(command: string, cwd: string, deps: ShellGateDeps = {}): Promise<BackgroundShellGate> {
	const config = deps.bashguardConfig ?? bashguardConfigFor(cwd);
	const decision = classifyCommand(command, cwd, config);
	if (decision.action === "block") return { blocked: decision.reason };
	const advisory = decision.action === "advise" ? decision.notice : undefined;
	const check = deps.sys1Check ?? sys1GateCheck;
	const gate = await check(command, undefined, cwd);
	if (gate?.block) return { blocked: gate.reason };
	return { advisory };
}

// --- Sandbox wrapper bridge ---------------------------------------------------
//
// hummin-sandbox registers this bridge at extension load so background shells
// can run under the same seatbelt/bwrap profile the bash tool uses. It lives
// on globalThis (the established extension-bridge pattern, cf.
// __humminOfflineFleetStarter) because core and sibling extensions cannot
// import the sandbox extension instance's closures.

export const SANDBOX_WRAP_KEY = "__humminSandboxWrap";

export type SandboxSpawnPlan =
	| { status: "unwrapped" }
	| { status: "wrapped"; command: string; args: string[] }
	| { status: "blocked"; reason: string };

export type SandboxWrapFn = (shellPath: string, command: string) => Promise<SandboxSpawnPlan>;

export function getSandboxWrap(): SandboxWrapFn | undefined {
	return (globalThis as Record<string, unknown>)[SANDBOX_WRAP_KEY] as SandboxWrapFn | undefined;
}
