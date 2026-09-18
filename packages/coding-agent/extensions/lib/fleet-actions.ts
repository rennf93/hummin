/** Shared hummin fleet server control: action command building, probes, and
 * readiness polling. Used by the /fleet panel (hummin-fleet.ts) and the
 * offline-model start flow in the /model picker. Extracted from
 * hummin-fleet.ts so both entry points share one implementation. */
import { spawn } from "node:child_process";
import { join } from "node:path";

export type FleetAction = "start" | "stop" | "restart";

/** One local inference server in the fleet (resolved display form). */
export interface FleetServer {
	id: string;
	label: string;
	hostLabel: string;
	hostIp: string;
	port: number;
	kind: "launchd" | "docker";
	target: string;
}

/** Raw fleet server entry as stored in settings (`fleet.servers`). */
export interface FleetServerSpec {
	id: string;
	label?: string;
	host?: string;
	hostIp: string;
	port: number;
	kind: "launchd" | "docker";
	target: string;
}

/** Minimal settings surface the fleet actions need (satisfied by SettingsManager). */
export interface FleetControlsSource {
	getFleetServers(): FleetServerSpec[];
	getFleetLaunchd(): { domain: string; plistDir: string };
	getFleetDocker(): { sshHost: string; composeDir: string };
}

const PROBE_TIMEOUT_MS = 8000;
const ACTION_TIMEOUT_MS = 30000;
const READY_POLL_ATTEMPTS = 10;
const READY_POLL_DELAY_MS = 500;

const q = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function fleetControls(settings: FleetControlsSource): { domain: string; plistDir: string; sshHost: string; composeDir: string } {
	const launchd = settings.getFleetLaunchd();
	const docker = settings.getFleetDocker();
	return { domain: launchd.domain, plistDir: launchd.plistDir, sshHost: docker.sshHost, composeDir: docker.composeDir };
}

export function fleetSettingsToServers(configured: readonly FleetServerSpec[]): FleetServer[] {
	return configured.map((server) => ({
		id: server.id,
		label: server.label ?? server.id,
		hostLabel: server.host ?? server.hostIp,
		hostIp: server.hostIp,
		port: server.port,
		kind: server.kind,
		target: server.target,
	}));
}

/** Build the shell command for a fleet action. Returns undefined when the
 * docker control endpoints are not configured. */
export function buildActionCommand(
	server: Pick<FleetServer, "kind" | "target">,
	action: FleetAction,
	controls: { domain: string; plistDir: string; sshHost: string; composeDir: string },
): string | undefined {
	if (server.kind === "launchd") {
		const plist = q(join(controls.plistDir, `${server.target}.plist`));
		const label = q(server.target);
		if (action === "start") return `launchctl load ${plist} 2>/dev/null; launchctl start ${label}`;
		if (action === "stop") return `launchctl stop ${label}; launchctl unload ${plist}`;
		return `launchctl stop ${label}; launchctl load ${plist} 2>/dev/null; launchctl start ${label}`;
	}
	if (!controls.sshHost || !controls.composeDir) return undefined;
	return `ssh -o ConnectTimeout=5 ${q(controls.sshHost)} ${q(`cd ${q(controls.composeDir)} && sudo docker compose ${action} ${q(server.target)}`)}`;
}

function runZsh(command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("/bin/zsh", ["-lc", command], { env: { ...process.env, HUMMIN_MEMORY: "0" } });
		let output = "";
		let settled = false;
		const finish = (ok: boolean, text: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ok, output: text.trim() });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false, "timeout");
		}, timeoutMs);
		const onAbort = (): void => {
			child.kill("SIGKILL");
			finish(false, "aborted");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.once("error", (error: Error) => finish(false, error.message));
		child.once("close", (code: number | null) => finish(code === 0, output || `exit ${code}`));
	});
}

export async function probeServer(
	server: FleetServer,
	controls: { domain: string; plistDir: string; sshHost: string; composeDir: string },
	signal?: AbortSignal,
): Promise<boolean> {
	if (server.kind === "launchd")
		return (
			await runZsh(
				`launchctl print ${q(`${controls.domain}/${server.target}`)} 2>/dev/null | grep -q 'state = running'`,
				PROBE_TIMEOUT_MS,
				signal,
			)
		).ok;
	if (!controls.sshHost || !controls.composeDir) return false;
	const remote = `sudo -n docker ps --format '{{.Names}}' --filter status=running | grep -Fxq ${q(server.target)}`;
	return (await runZsh(`ssh -o ConnectTimeout=5 ${q(controls.sshHost)} ${q(remote)}`, PROBE_TIMEOUT_MS, signal)).ok;
}

export async function probeFleet(
	servers: readonly FleetServer[],
	controls: { domain: string; plistDir: string; sshHost: string; composeDir: string },
): Promise<Map<string, boolean>> {
	const results = await Promise.all(
		servers.map(async (server) => [server.id, await probeServer(server, controls)] as const),
	);
	return new Map(results);
}

export interface FleetActionOptions {
	/** Aborting kills the running action command and stops readiness polling. */
	signal?: AbortSignal;
	/** Injectable command runner (defaults to /bin/zsh). */
	run?: (command: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;
	/** Injectable readiness probe. */
	probe?: (server: FleetServer) => Promise<boolean>;
	/** Delay between readiness polls (tests pass 0). */
	readyDelayMs?: number;
}

/** Run a start/stop/restart action, then poll readiness (10 x 500ms) exactly
 * like the /fleet panel always did. */
export async function performFleetAction(
	server: FleetServer,
	action: FleetAction,
	controls: { domain: string; plistDir: string; sshHost: string; composeDir: string },
	options: FleetActionOptions = {},
): Promise<{ ok: boolean; up: boolean; detail: string }> {
	const run = options.run ?? runZsh;
	const probe = options.probe ?? ((target: FleetServer) => probeServer(target, controls, options.signal));
	const command = buildActionCommand(server, action, controls);
	if (command === undefined) return { ok: false, up: false, detail: "docker endpoint is not configured" };
	const result = await run(command, ACTION_TIMEOUT_MS, options.signal);
	let up = await probe(server);
	const expected = action !== "stop";
	for (let attempt = 0; result.ok && up !== expected && attempt < READY_POLL_ATTEMPTS; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, options.readyDelayMs ?? READY_POLL_DELAY_MS));
		if (options.signal?.aborted) return { ok: false, up, detail: `${action} aborted` };
		up = await probe(server);
	}
	if (options.signal?.aborted) return { ok: false, up, detail: `${action} aborted` };
	return {
		ok: result.ok && up === expected,
		up,
		detail: result.ok
			? `${action}: ${up === expected ? (expected ? "up" : "stopped") : expected ? "failed to become ready" : "still running"}`
			: `${action} failed: ${result.output.slice(0, 120)}`,
	};
}
