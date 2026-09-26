/** Fleet health and controls for hummin's local inference servers. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	estimateSystemPromptSectionTokens,
	SettingsManager,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import {
	fleetControls,
	fleetSettingsToServers,
	performFleetAction,
	type FleetAction,
	type FleetServer,
	probeFleet as probeFleetServers,
	probeServer as probeFleetServer,
} from "./lib/fleet-actions.ts";

export type { FleetAction, FleetServer };
export { fleetSettingsToServers };
/** Fleet is private configuration. An empty list is a valid unconfigured state. */
export const DEFAULT_FLEET: readonly FleetServer[] = [];
const settingsFor = (ctx: ExtensionContext) => SettingsManager.create(ctx.cwd);
export function serversFor(ctx: ExtensionContext): FleetServer[] {
	const configured = settingsFor(ctx).getFleetServers();
	if (configured.length === 0) return DEFAULT_FLEET.map((server) => ({ ...server }));
	return fleetSettingsToServers(configured);
}
export async function probeServer(server: FleetServer, ctx: ExtensionContext): Promise<boolean> {
	return probeFleetServer(server, fleetControls(settingsFor(ctx)));
}
export async function probeFleet(
	servers: readonly FleetServer[],
	ctx: ExtensionContext,
): Promise<Map<string, boolean>> {
	return probeFleetServers(servers, fleetControls(settingsFor(ctx)));
}
function performAction(
	server: FleetServer,
	action: FleetAction,
	ctx: ExtensionContext,
): Promise<{ ok: boolean; up: boolean; detail: string }> {
	return performFleetAction(server, action, fleetControls(settingsFor(ctx)));
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

/** Warn when a single section or the prompt total grows past these estimated token budgets. */
export const PROMPT_SECTION_WARN_TOKENS = 4000;
export const PROMPT_TOTAL_WARN_TOKENS = 20000;

/**
 * Per-section token estimates for the standing system prompt, from the base prompt options
 * (ctx.getSystemPromptOptions). Sections added by before_agent_start handlers are per-run and
 * not part of the base options, so they are not listed here.
 */
export function promptSectionLines(options: BuildSystemPromptOptions): string[] {
	const estimates = estimateSystemPromptSectionTokens(options);
	if (!estimates) {
		const tokens = Math.ceil((options.forceSystemPrompt?.length ?? 0) / 4);
		return [`prompt: forced, ~${tokens.toLocaleString()} tokens (est.), sections not shown`];
	}
	const entries = Object.entries(estimates);
	const total = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
	const lines = [
		"prompt sections (est. tokens):",
		...entries.map(([name, tokens]) => `  ${name}: ${tokens.toLocaleString()}`),
		`  total: ~${total.toLocaleString()}`,
	];
	for (const [name, tokens] of entries.filter(([, tokens]) => tokens > PROMPT_SECTION_WARN_TOKENS)) {
		lines.push(`warning: prompt section ${name} over ${PROMPT_SECTION_WARN_TOKENS.toLocaleString()} tokens (~${tokens.toLocaleString()})`);
	}
	if (total > PROMPT_TOTAL_WARN_TOKENS) {
		lines.push(`warning: prompt total over ${PROMPT_TOTAL_WARN_TOKENS.toLocaleString()} tokens (~${total.toLocaleString()})`);
	}
	return lines;
}

/** Result contract for the /model picker's offline-server start flow. Kept
 * structural so the picker (core) and this extension stay decoupled. */
interface PickerStartResult {
	ok: boolean;
	detail: string;
	cancelled?: boolean;
}

function readAutoStart(fleet: unknown): boolean | undefined {
	if (!fleet || typeof fleet !== "object") return undefined;
	const value = (fleet as { autoStart?: unknown }).autoStart;
	return typeof value === "boolean" ? value : undefined;
}

/** hummin: fleet.autoStart skips the "Start <server>?" confirm (env > project > global). */
function fleetAutoStart(settings: SettingsManager): boolean {
	if (process.env.HUMMIN_FLEET_AUTOSTART === "1") return true;
	if (process.env.HUMMIN_FLEET_AUTOSTART === "0") return false;
	return readAutoStart(settings.getProjectSettings().fleet) ?? readAutoStart(settings.getGlobalSettings().fleet) ?? false;
}

/** Register the global bridge the /model picker uses to start an offline
 * fleet server (same action path as /fleet). The picker lives in core and
 * cannot import extension code, so the handoff is a well-known globalThis key. */
const OFFLINE_FLEET_STARTER_KEY = "__humminOfflineFleetStarter";

export default function (pi: ExtensionAPI): void {
	let pickerUi: ExtensionContext["ui"] | undefined;
	const captureUi = (ctx: ExtensionContext): void => {
		if (ctx.mode === "tui") pickerUi = ctx.ui;
	};
	pi.on?.("session_start", (_event, ctx) => captureUi(ctx));
	pi.registerCommand("fleet", {
		description: "Show and control the local inference fleet",
		handler: async (_args, ctx) => {
			captureUi(ctx);
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
		description: "Show hummin status: model, fleet, memory, and system prompt section sizes",
		handler: async (_args, ctx) => {
			const servers = serversFor(ctx);
			const states = await probeFleet(servers, ctx);
			let promptLines: string[];
			try {
				promptLines = promptSectionLines(ctx.getSystemPromptOptions());
			} catch (error) {
				promptLines = [`prompt sections: unavailable (${error instanceof Error ? error.message : String(error)})`];
			}
			ctx.ui.notify([statusText(ctx, servers, states), ...promptLines].join("\n"), "info");
		},
	});

	const startForPicker = async (serverId: string, signal: AbortSignal): Promise<PickerStartResult> => {
		const settings = SettingsManager.create(process.cwd());
		const server = fleetSettingsToServers(settings.getFleetServers()).find((entry) => entry.id === serverId);
		if (!server) return { ok: false, detail: `fleet server ${serverId} is not configured` };
		if (!pickerUi && !fleetAutoStart(settings))
			return { ok: false, detail: "fleet ui unavailable", cancelled: true };
		if (!fleetAutoStart(settings)) {
			const confirmed = await pickerUi!.confirm("Fleet", `Start ${server.label}? (fleet)`);
			if (!confirmed) return { ok: false, detail: "cancelled", cancelled: true };
		}
		pickerUi?.notify(`Starting ${server.label}…`, "info");
		const result = await performFleetAction(server, "start", fleetControls(settings), { signal });
		pickerUi?.notify(
			`${server.id}: ${result.detail}`,
			result.ok && result.up ? "info" : "warning",
		);
		return result;
	};
	(globalThis as Record<string, unknown>)[OFFLINE_FLEET_STARTER_KEY] = startForPicker;
}
