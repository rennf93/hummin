/**
 * hummin-sandbox: sandboxed bash (workspace mode).
 *
 * Overrides the built-in `bash` tool by re-registering the same name. When
 * sandbox mode is "workspace", commands run under a macOS seatbelt profile
 * (sandbox-exec) or a Linux bubblewrap argv; secrets (~/.ssh, ~/.gnupg,
 * ~/.hummin/agent) and non-project *.env files are unreadable, writes are
 * limited to the working directory and $TMPDIR, and network access follows
 * the configured policy.
 *
 * Config: settings `sandbox: { mode, network, fallback }` (global + project),
 * env `HUMMIN_SANDBOX=0|workspace` overrides the mode. Default mode "off".
 * `/sandbox` shows a /doctor-style status table and toggles the mode.
 *
 * Spawned task children inherit the mode: when workspace is active we set
 * HUMMIN_SANDBOX in our own environment so children copy it. Every spawned
 * child gets HUMMIN_MEMORY=0. Timeout/abort kills the exact sandbox
 * runner PID we spawned (never a process-name search).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access as fsAccess, constants as fsConstants, mkdtemp, open as fsOpen, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import {
	SettingsManager,
	createBashToolDefinition,
	getAgentDir,
	getShellConfig,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/sandbox-wrap.test.ts)
// ---------------------------------------------------------------------------

export type SandboxMode = "off" | "workspace";
export type SandboxNetwork = "allow" | "deny";
export type SandboxFallback = "block" | "allow";

export interface SandboxConfig {
	mode: SandboxMode;
	network: SandboxNetwork;
	fallback: SandboxFallback;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = { mode: "off", network: "allow", fallback: "block" };

const SANDBOX_ENTRY = "hummin-sandbox-mode";

/** Read the `sandbox` namespace out of a raw settings object. */
function readSandboxNamespace(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	return (raw as Record<string, unknown>).sandbox;
}

/** Parse one settings `sandbox` namespace; unknown shapes are ignored. */
export function parseSandboxNamespace(raw: unknown): Partial<SandboxConfig> {
	if (typeof raw !== "object" || raw === null) return {};
	const obj = raw as Record<string, unknown>;
	const out: Partial<SandboxConfig> = {};
	if (obj.mode === "off" || obj.mode === "workspace") out.mode = obj.mode;
	if (obj.network === "allow" || obj.network === "deny") out.network = obj.network;
	if (obj.fallback === "block" || obj.fallback === "allow") out.fallback = obj.fallback;
	return out;
}

/**
 * Resolve the active config. Precedence: env HUMMIN_SANDBOX (mode only)
 * > project settings > global settings > defaults.
 */
export function resolveSandboxConfig(
	env: Readonly<Record<string, string | undefined>>,
	globalRaw: unknown,
	projectRaw: unknown,
): SandboxConfig {
	const global = parseSandboxNamespace(readSandboxNamespace(globalRaw));
	const project = parseSandboxNamespace(readSandboxNamespace(projectRaw));
	const config: SandboxConfig = {
		mode: project.mode ?? global.mode ?? DEFAULT_SANDBOX_CONFIG.mode,
		network: project.network ?? global.network ?? DEFAULT_SANDBOX_CONFIG.network,
		fallback: project.fallback ?? global.fallback ?? DEFAULT_SANDBOX_CONFIG.fallback,
	};
	const envMode = env.HUMMIN_SANDBOX;
	if (envMode !== undefined && envMode !== "") {
		if (envMode === "0" || envMode === "off") config.mode = "off";
		else if (envMode === "workspace" || envMode === "1") config.mode = "workspace";
	}
	return config;
}

/** Paths that must never be readable inside the sandbox. */
export function secretReadDenySubpaths(home: string): string[] {
	return [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".hummin", "agent")];
}

/** Escape a literal path for use inside a seatbelt regex #"..."# literal. */
export function escapeSeatbeltRegexLiteral(path: string): string {
	return path.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
}

/**
 * Generate the seatbelt profile. Read is allowed everywhere except secret
 * paths and *.env files outside the working directory; write is allowed only
 * for the working directory and the temp directory (deny default covers the
 * rest). Network follows the policy.
 */
export function buildSeatbeltProfile(opts: {
	home: string;
	cwd: string;
	tmpDir: string;
	networkDeny: boolean;
}): string {
	const denies = secretReadDenySubpaths(opts.home)
		.map((p) => `  (deny file-read* (subpath "${p}"))`)
		.join("\n");
	const envRegex = `^(?!${escapeSeatbeltRegexLiteral(opts.cwd)}).*/[^/]*\\.env$`;
	const network = opts.networkDeny ? "" : "(allow network*)\n";
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow file-read*)",
		denies,
		`  (deny file-read* (regex #"${envRegex}"#))`,
		`(allow file-write* (subpath "${opts.cwd}"))`,
		`(allow file-write* (subpath "${opts.tmpDir}"))`,
		network,
		")",
	].join("\n");
}

/**
 * Build the bubblewrap argv. / is mounted read-only, the working directory
 * and temp dir are read-write, /dev, /proc and a fresh /tmp are set up, and
 * the network namespace is dropped when the policy denies network.
 */
export function buildBwrapArgv(opts: {
	bwrapPath?: string;
	cwd: string;
	tmpDir: string;
	networkDeny: boolean;
	shellPath: string;
	command: string;
}): string[] {
	const argv = [
		opts.bwrapPath ?? "bwrap",
		"--ro-bind",
		"/",
		"/",
		"--bind",
		opts.cwd,
		opts.cwd,
		"--bind",
		opts.tmpDir,
		opts.tmpDir,
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--die-with-parent",
	];
	if (opts.networkDeny) argv.push("--unshare-net");
	argv.push("--", opts.shellPath, "-c", opts.command);
	return argv;
}

/** /doctor-style aligned two-column table text. */
export function formatSandboxTable(rows: ReadonlyArray<readonly [string, string]>): string {
	const width = Math.max(...rows.map(([k]) => k.length));
	return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

/** Cache wrapper: run() executes at most once per key. */
export async function cachedProbe(
	cache: Map<string, boolean>,
	key: string,
	run: () => Promise<boolean>,
): Promise<boolean> {
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const result = await run();
	cache.set(key, result);
	return result;
}

// ---------------------------------------------------------------------------
// Capability probes (real execution, cached; never inferred from presence)
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 5000;

function runProbe(argv: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(argv[0], argv.slice(1), { stdio: "ignore", env: { ...process.env, HUMMIN_MEMORY: "0" } });
		} catch {
			resolve(false);
			return;
		}
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ok);
		};
		const timer = setTimeout(() => {
			if (child.pid) child.kill("SIGKILL");
			done(false);
		}, PROBE_TIMEOUT_MS);
		child.on("error", () => done(false));
		child.on("exit", (code) => done(code === 0));
	});
}

async function probeSeatbelt(profilePath: string): Promise<boolean> {
	return runProbe(["/usr/bin/sandbox-exec", "-f", profilePath, "/bin/true"]);
}

async function probeBwrap(): Promise<boolean> {
	return runProbe(["bwrap", "--ro-bind", "/", "/", "/bin/true"]);
}

// ---------------------------------------------------------------------------
// Sandbox runner (exact-PID kill, streamed output)
// ---------------------------------------------------------------------------

const KILL_GRACE_MS = 1500;

function killExact(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, KILL_GRACE_MS).unref();
}

export function sandboxOperations(ops: {
	activeConfig: () => Promise<{ networkDeny: boolean; argv: (shellPath: string, command: string) => string[] } | undefined>;
	shellPath: () => string;
	fallback: () => "block" | "allow";
	mode: () => "off" | "workspace";
	onFallbackNotice?: () => void;
}): BashOperations {
	const plainExec = async (command: string, cwd: string, io: { onData: (data: Buffer) => void; signal?: AbortSignal; env?: Record<string, string | undefined> }) => {
		const child = spawn(ops.shellPath(), ["-c", command], {
			cwd,
			env: { ...(io.env ?? process.env), HUMMIN_MEMORY: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (d) => io.onData(d));
		child.stderr?.on("data", (d) => io.onData(d));
		if (io.signal) {
			if (io.signal.aborted) killExact(child);
			else io.signal.addEventListener("abort", () => killExact(child), { once: true });
		}
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (c) => resolve(c ?? (child.signalCode ? 128 : 1)));
		});
		if (io.signal?.aborted) throw new Error("aborted");
		return { exitCode: code === null ? 1 : code };
	};
	return {
		exec: async (command, cwd, { onData, signal, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			try {
				await fsAccess(cwd, fsConstants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute sandboxed commands.`);
			}
			const plan = await ops.activeConfig();
			if (!plan) {
				if (ops.mode() !== "workspace") {
					return plainExec(command, cwd, { onData, signal, env });
				}
				if (ops.fallback() === "allow") {
					ops.onFallbackNotice?.();
					return plainExec(command, cwd, { onData, signal, env });
				}
				throw new Error(
					'[Sandbox] workspace mode is on but no sandbox mechanism is available. Set sandbox.fallback to "allow" or sandbox.mode to "off" (/sandbox).',
				);
			}
			const argv = plan.argv(ops.shellPath(), command);
			const child = spawn(argv[0], argv.slice(1), {
				cwd,
				env: { ...(env ?? process.env), HUMMIN_MEMORY: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			if (signal) {
				if (signal.aborted) killExact(child);
				else signal.addEventListener("abort", () => killExact(child), { once: true });
			}
			const exitCode = await new Promise<number | null>((resolve, reject) => {
				child.on("error", reject);
				child.on("exit", (code) => resolve(code ?? (child.signalCode ? 128 : 1)));
			});
			if (signal?.aborted) throw new Error("aborted");
			return { exitCode: exitCode === null ? 1 : exitCode };
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function settingsToRaw(settings: SettingsManager): { global: unknown; project: unknown } {
	return {
		global: settings.getGlobalSettings() as unknown as Record<string, unknown>,
		project: settings.getProjectSettings() as unknown as Record<string, unknown>,
	};
}

function reconstructOverride(ctx: ExtensionContext): SandboxMode | undefined {
	let override: SandboxMode | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && (entry as { customType?: string }).customType === SANDBOX_ENTRY) {
			const data = (entry as { data?: { mode?: SandboxMode } }).data;
			if (data && (data.mode === "off" || data.mode === "workspace")) override = data.mode;
		}
	}
	return override;
}

/** Persist the sandbox mode into the global settings file (additive edit). */
async function persistGlobalMode(mode: SandboxMode): Promise<void> {
	const path = join(getAgentDir(), "settings.json");
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		parsed = {};
	}
	const sandbox = (typeof parsed.sandbox === "object" && parsed.sandbox !== null ? parsed.sandbox : {}) as Record<string, unknown>;
	sandbox.mode = mode;
	parsed.sandbox = sandbox;
	await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

let envOverrideSetByUs = false;

export default function humminSandbox(pi: ExtensionAPI): void {
	const settings = SettingsManager.create(process.cwd());
	const probeCache = new Map<string, boolean>();
	let sessionOverride: SandboxMode | undefined;
	let notifiedUnsupported = false;
	const home = homedir();

	const configNow = (): SandboxConfig => {
		const { global, project } = settingsToRaw(settings);
		return resolveSandboxConfig(process.env, global, project);
	};
	const activeMode = (): SandboxMode => sessionOverride ?? configNow().mode;

	// Task children inherit the mode through the environment.
	if (activeMode() === "workspace" && process.env.HUMMIN_SANDBOX === undefined) {
		process.env.HUMMIN_SANDBOX = "workspace";
		envOverrideSetByUs = true;
	}

	const sandboxSupport = async (): Promise<"seatbelt" | "bwrap" | undefined> => {
		const platform = osPlatform();
		if (platform === "darwin") {
			const tmpDir = await mkdtemp(join(tmpdir(), "hummin-sandbox-"));
			try {
				const probeProfilePath = join(tmpDir, "probe.sb");
				const handle = await fsOpen(probeProfilePath, "wx", 0o600);
				await handle.writeFile("(version 1)(allow default)");
				await handle.close();
				const ok = await cachedProbe(probeCache, "seatbelt", () => probeSeatbelt(probeProfilePath));
				return ok ? "seatbelt" : undefined;
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		}
		if (platform === "linux") {
			const ok = await cachedProbe(probeCache, "bwrap", probeBwrap);
			return ok ? "bwrap" : undefined;
		}
		return undefined;
	};

	let notifiedFallback = false;
	const ops = sandboxOperations({
		shellPath: () => getShellConfig(settings.getShellPath()).shell,
		fallback: () => configNow().fallback,
		mode: () => activeMode(),
		onFallbackNotice: () => {
			if (!notifiedFallback) {
				notifiedFallback = true;
			}
		},
		activeConfig: async () => {
			if (activeMode() !== "workspace") return undefined;
			const support = await sandboxSupport();
			if (!support) return undefined;
			const cwd = process.cwd();
			const tmpDir = tmpdir();
			const networkDeny = configNow().network === "deny";
			if (support === "seatbelt") {
				const dir = await mkdtemp(join(tmpDir, "hummin-sandbox-"));
				const profilePath = join(dir, "exec.sb");
				const handle = await fsOpen(profilePath, "wx", 0o600);
				await handle.writeFile(buildSeatbeltProfile({ home, cwd, tmpDir, networkDeny }));
				await handle.close();
				return {
					networkDeny,
					argv: (shellPath, command) => ["/usr/bin/sandbox-exec", "-f", profilePath, shellPath, "-c", command],
				};
			}
			return {
				networkDeny,
				argv: (shellPath, command) => buildBwrapArgv({ cwd, tmpDir, networkDeny, shellPath, command }),
			};
		},
	});

	const baseBash = createBashToolDefinition(process.cwd(), { operations: ops });
	pi.registerTool({
		...baseBash,
		description:
			`${baseBash.description} When hummin sandbox workspace mode is active, commands run sandboxed: ` +
			`secrets (~/.ssh, ~/.gnupg, ~/.hummin/agent) and *.env files outside the project are unreadable, ` +
			`writes are limited to the working directory and temp, and network access follows the configured policy.`,
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionOverride = reconstructOverride(ctx);
		if (activeMode() === "workspace") {
			const support = await sandboxSupport();
			if (!support && !notifiedUnsupported) {
				notifiedUnsupported = true;
				ctx.ui.notify(
					`[Sandbox] workspace mode is on but no sandbox mechanism is available on ${osPlatform()}. ` +
						`Set sandbox.fallback to "allow" in settings to run unsandboxed, or "block" (default) to keep bash blocked.`,
					"warning",
				);
			}
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		sessionOverride = reconstructOverride(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		if (activeMode() !== "workspace") return;
		const support = await sandboxSupport();
		if (support) return;
		if (configNow().fallback === "allow") {
			if (!notifiedUnsupported) {
				notifiedUnsupported = true;
				ctx.ui.notify("[Sandbox] no sandbox mechanism available; running bash unsandboxed (sandbox.fallback: allow)", "warning");
			}
			return;
		}
		return {
			block: true,
			reason:
				`[Sandbox] bash is blocked: workspace mode is on but no sandbox mechanism is available on ${osPlatform()}. ` +
				`Ask the user to install bubblewrap (Linux), or set sandbox.fallback to "allow" in settings to run unsandboxed.`,
		};
	});

	const statusTable = async (): Promise<string> => {
		const config = configNow();
		const mode = sessionOverride ?? config.mode;
		const support = await sandboxSupport();
		return formatSandboxTable([
			["mode", `${mode}${sessionOverride !== undefined ? " (session override)" : ""}`],
			["network", config.network],
			["fallback", config.fallback],
			["platform", osPlatform()],
			["mechanism", support ?? "none available"],
			["env override", process.env.HUMMIN_SANDBOX ?? "-"],
		] as const);
	};

	pi.registerCommand("sandbox", {
		description: "Show hummin sandbox status and toggle workspace mode",
		category: "Sandbox",
		handler: async (_args, ctx) => {
			const before = activeMode();
			ctx.ui.notify(`[Sandbox] status\n${await statusTable()}`, "info");
			const choice = await ctx.ui.select(
				"Sandbox",
				[
					`${before === "workspace" ? "Disable" : "Enable"} workspace mode (persisted)`,
					`Toggle network ${configNow().network === "deny" ? "allow" : "deny"} (persisted)`,
					"Close",
				],
			);
			if (choice === undefined || choice.startsWith("Close")) return;
			if (choice.startsWith("Enable") || choice.startsWith("Disable")) {
				const next: SandboxMode = before === "workspace" ? "off" : "workspace";
				sessionOverride = next;
				pi.appendEntry(SANDBOX_ENTRY, { mode: next });
				try {
					await persistGlobalMode(next);
				} catch (error) {
					ctx.ui.notify(`[Sandbox] could not persist mode (${error instanceof Error ? error.message : String(error)}); session override kept`, "warning");
				}
				if (next === "workspace" && process.env.HUMMIN_SANDBOX === undefined) {
					process.env.HUMMIN_SANDBOX = "workspace";
					envOverrideSetByUs = true;
				} else if (next === "off" && envOverrideSetByUs) {
					delete process.env.HUMMIN_SANDBOX;
					envOverrideSetByUs = false;
				}
				ctx.ui.notify(`[Sandbox] workspace mode ${next === "workspace" ? "enabled" : "disabled"}. Spawned task children inherit the mode.`, "info");
				return;
			}
			const network: SandboxNetwork = configNow().network === "deny" ? "allow" : "deny";
			const path = join(getAgentDir(), "settings.json");
			try {
				const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
				const sandbox = (typeof parsed.sandbox === "object" && parsed.sandbox !== null ? parsed.sandbox : {}) as Record<string, unknown>;
				sandbox.network = network;
				parsed.sandbox = sandbox;
				await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
				ctx.ui.notify(`[Sandbox] network ${network === "deny" ? "denied" : "allowed"} (persisted).`, "info");
			} catch (error) {
				ctx.ui.notify(`[Sandbox] could not persist network policy (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
		},
	});
}
