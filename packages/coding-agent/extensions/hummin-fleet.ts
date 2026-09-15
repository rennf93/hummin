/** Fleet health and controls for hummin's local inference servers. */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

export type FleetAction = "start" | "stop" | "restart";
export interface FleetServer {
	id: string;
	label: string;
	hostLabel: string;
	hostIp: string;
	port: number;
	kind: "launchd" | "docker";
	target: string;
}
/** Fleet is private configuration. An empty list is a valid unconfigured state. */
export const DEFAULT_FLEET: readonly FleetServer[] = [];
const PROBE_TIMEOUT_MS = 8000;
const ACTION_TIMEOUT_MS = 30000;
const q = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const settingsFor = (ctx: ExtensionContext) => SettingsManager.create(ctx.cwd);
function runZsh(command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("/bin/zsh", ["-lc", command], { env: { ...process.env, HUMMIN_MEMORY: "0" } });
		let output = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve({ ok: false, output: "timeout" });
		}, timeoutMs);
		const finish = (ok: boolean, text: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, output: text.trim() });
		};
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.once("error", (error: Error) => finish(false, error.message));
		child.once("close", (code: number | null) => finish(code === 0, output || `exit ${code}`));
	});
}
export function serversFor(ctx: ExtensionContext): FleetServer[] {
	const configured = settingsFor(ctx).getFleetServers();
	if (configured.length === 0) return DEFAULT_FLEET.map((server) => ({ ...server }));
	return fleetSettingsToServers(configured);
}
export function fleetSettingsToServers(configured: readonly { id: string; label?: string; host?: string; hostIp: string; port: number; kind: "launchd" | "docker"; target: string }[]): FleetServer[] {
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
function controls(ctx: ExtensionContext): { domain: string; plistDir: string; sshHost: string; composeDir: string } {
	const settings = settingsFor(ctx);
	const launchd = settings.getFleetLaunchd();
	const docker = settings.getFleetDocker();
	return {
		domain: launchd.domain,
		plistDir: launchd.plistDir,
		sshHost: docker.sshHost,
		composeDir: docker.composeDir,
	};
}
export async function probeServer(server: FleetServer, ctx: ExtensionContext): Promise<boolean> {
	const config = controls(ctx);
	if (server.kind === "launchd")
		return (
			await runZsh(
				`launchctl print ${q(`${config.domain}/${server.target}`)} 2>/dev/null | grep -q 'state = running'`,
				PROBE_TIMEOUT_MS,
			)
		).ok;
	if (!config.sshHost || !config.composeDir) return false;
	const remote = `sudo -n docker ps --format '{{.Names}}' --filter status=running | grep -Fxq ${q(server.target)}`;
	return (await runZsh(`ssh -o ConnectTimeout=5 ${q(config.sshHost)} ${q(remote)}`, PROBE_TIMEOUT_MS)).ok;
}
export async function probeFleet(
	servers: readonly FleetServer[],
	ctx: ExtensionContext,
): Promise<Map<string, boolean>> {
	const results = await Promise.all(
		servers.map(async (server) => [server.id, await probeServer(server, ctx)] as const),
	);
	return new Map(results);
}
async function performAction(
	server: FleetServer,
	action: FleetAction,
	ctx: ExtensionContext,
): Promise<{ ok: boolean; up: boolean; detail: string }> {
	const config = controls(ctx);
	let command: string;
	if (server.kind === "launchd") {
		const plist = q(join(config.plistDir, `${server.target}.plist`));
		const label = q(server.target);
		command =
			action === "start"
				? `launchctl load ${plist} 2>/dev/null; launchctl start ${label}`
				: action === "stop"
					? `launchctl stop ${label}; launchctl unload ${plist}`
					: `launchctl stop ${label}; launchctl load ${plist} 2>/dev/null; launchctl start ${label}`;
	} else {
		if (!config.sshHost || !config.composeDir)
			return { ok: false, up: false, detail: "docker endpoint is not configured" };
		command = `ssh -o ConnectTimeout=5 ${q(config.sshHost)} ${q(`cd ${q(config.composeDir)} && sudo docker compose ${action} ${q(server.target)}`)}`;
	}
	const result = await runZsh(command, ACTION_TIMEOUT_MS);
	let up = await probeServer(server, ctx);
	const expected = action !== "stop";
	for (let attempt = 0; result.ok && up !== expected && attempt < 10; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		up = await probeServer(server, ctx);
	}
	return {
		ok: result.ok && up === expected,
		up,
		detail: result.ok
			? `${action}: ${up === expected ? (expected ? "up" : "stopped") : expected ? "failed to become ready" : "still running"}`
			: `${action} failed: ${result.output.slice(0, 120)}`,
	};
}

function countEntityFiles(directory: string): number {
	if (!existsSync(directory)) return 0;
	let count = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) count += countEntityFiles(path);
		else if (entry.isFile() && path.endsWith(".md")) count++;
	}
	return count;
}
class FleetComponent {
	private selected = 0;
	private timer: NodeJS.Timeout;
	private states = new Map<string, boolean>();
	private probing = false;
	private disposed = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly servers: readonly FleetServer[];
	private readonly ctx: ExtensionContext;
	private readonly done: (server?: FleetServer) => void;
	private readonly readOnly: boolean;
	constructor(
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		servers: readonly FleetServer[],
		ctx: ExtensionContext,
		done: (server?: FleetServer) => void,
		readOnly: boolean,
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.servers = servers;
		this.ctx = ctx;
		this.done = done;
		this.readOnly = readOnly;
		this.timer = setInterval(() => void this.refresh(), 5000);
		void this.refresh();
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
	invalidate(): void {}
	private async refresh(): Promise<void> {
		if (this.probing || this.disposed) return;
		this.probing = true;
		this.states = await probeFleet(this.servers, this.ctx);
		this.probing = false;
		if (!this.disposed) this.tui.requestRender();
	}
	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.kb.matches(data, "tui.select.up"))
			this.selected = (this.selected + this.servers.length - 1) % this.servers.length;
		else if (this.kb.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.servers.length;
		else if (!this.readOnly && this.kb.matches(data, "tui.select.confirm")) {
			this.done(this.servers[this.selected]);
			return;
		}
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const up = [...this.states.values()].filter(Boolean).length;
		const title =
			this.probing && this.states.size === 0 ? "Fleet · probing…" : `Fleet · ${up}/${this.servers.length} up`;
		const lines = [`  ${this.theme.fg("accent", this.theme.bold(title))}`, ""];
		for (const [index, server] of this.servers.entries()) {
			const state = this.states.get(server.id);
			const dot =
				state === undefined
					? this.theme.fg("muted", "…")
					: state
						? this.theme.fg("success", "●")
						: this.theme.fg("error", "○");
			lines.push(
				truncateToWidth(
					`  ${index === this.selected ? this.theme.fg("accent", "▸") : " "} ${dot} ${server.label.padEnd(20)} ${server.hostLabel} :${server.port}  ${server.kind} ${server.target}`,
					width,
				),
			);
		}
		lines.push(
			"",
			`  ${this.theme.fg("dim", this.readOnly ? "Escape to close" : "↑/↓ select · Enter action · Escape close")}`,
		);
		return lines;
	}
}
function todoSummary(ctx: ExtensionContext): string {
	let todos: Array<{ status: string }> | undefined;
	for (const entry of ctx.sessionManager.getBranch())
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo")
			todos = (entry.message.details as { todos?: Array<{ status: string }> } | undefined)?.todos;
	return todos?.length
		? `${todos.filter((todo) => todo.status === "completed").length}/${todos.length} complete`
		: "none";
}
function statusText(ctx: ExtensionContext, servers: readonly FleetServer[], states: Map<string, boolean>): string {
	const settings = settingsFor(ctx);
	const vault = settings.getMemoryVaultDir();
	const entities = countEntityFiles(join(vault, "entities"));
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const context = ctx.model ? `${ctx.model.contextWindow.toLocaleString()} tokens` : "unknown";
	return [
		`model: ${model} (${context})`,
		`memory: ${settings.getMemoryEnabled() ? "on" : "off"} / ${settings.getMemoryMode()} / ${vault} (${entities} entities)`,
		`todos: ${todoSummary(ctx)}`,
		`tui: ${settings.getTuiMode()}`,
		"fleet:",
		...servers.map(
			(server) => `${server.hostLabel} ${server.label} :${server.port} ${states.get(server.id) ? "up" : "down"}`,
		),
	].join("\n");
}
export default function (pi: ExtensionAPI): void {
	pi.registerCommand("fleet", {
		description: "Show and control the local inference fleet",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/fleet requires interactive mode", "error");
				return;
			}
			const servers = serversFor(ctx);
			if (servers.length === 0) {
				ctx.ui.notify("fleet is not configured", "info");
				return;
			}
			const selected = await ctx.ui.custom<FleetServer | undefined>(
				(tui, theme, kb, done) => new FleetComponent(tui, theme, kb, servers, ctx, done, false),
			);
			if (!selected) return;
			const action = await ctx.ui.select(`${selected.label} (${selected.hostLabel})`, ["Start", "Stop", "Restart"]);
			if (!action) return;
			const result = await performAction(selected, action.toLowerCase() as FleetAction, ctx);
			ctx.ui.notify(
				`${selected.id}: ${result.detail}`,
				result.ok && (result.up || action === "Stop") ? "info" : "warning",
			);
		},
	});
	pi.registerCommand("status", {
		description: "Show hummin status and fleet health",
		handler: async (_args, ctx) => {
			const servers = serversFor(ctx);
			const states = await probeFleet(servers, ctx);
			ctx.ui.notify(statusText(ctx, servers, states), "info");
		},
	});
}
