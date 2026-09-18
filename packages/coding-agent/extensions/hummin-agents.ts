/**
 * hummin agents: inter-session messaging across terminals and projects.
 *
 * One broker per agent dir (first session to bind wins); sessions register
 * by name and exchange newline-JSON frames over a Unix domain socket.
 * Offline peers get a capped JSONL inbox, replayed on their next register.
 * Incoming messages are data, not instructions: delivered verbatim.
 *
 * Config: settings `agents: { enabled?: boolean, name?: string }` (global +
 * project, project wins); env HUMMIN_AGENTS=0 forces off, HUMMIN_AGENTS_NAME
 * overrides the name. Registration requires project trust (like monitors).
 */
import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type KeybindingsManager as KbManager, type TUI } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { Type } from "typebox";
import {
	BrokerClient,
	BrokerServer,
	clearInbox,
	drainInbox,
	inboxPath,
	MAX_TEXT,
	readInbox,
	sanitizeName,
	type AckFrame,
	type DeliverFrame,
	type SessionInfo,
} from "./lib/agents-broker.ts";

const NAME_ENTRY = "hummin-agent-name";
const RECONNECT_INTERVAL_MS = 5000;

interface AgentsSettings {
	enabled?: boolean;
	name?: string;
}

function readAgentsNamespace(raw: unknown): AgentsSettings {
	return (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as AgentsSettings;
}

export function agentsConfig(cwd: string): { enabled: boolean; name: string | undefined } {
	const settings = SettingsManager.create(cwd);
	const global = readAgentsNamespace((settings.getGlobalSettings() as unknown as { agents?: unknown }).agents);
	const project = settings.isProjectTrusted()
		? readAgentsNamespace((settings.getProjectSettings() as unknown as { agents?: unknown }).agents)
		: {};
	const enabled = process.env.HUMMIN_AGENTS === "0" ? false : (project.enabled ?? global.enabled ?? true);
	const name = process.env.HUMMIN_AGENTS_NAME ?? project.name ?? global.name;
	return { enabled, name };
}

/** Last persisted registry name from the session branch (branch-safe, survives resume). */
export function persistedName(ctx: ExtensionContext): string | undefined {
	for (let index = ctx.sessionManager.getBranch().length - 1; index >= 0; index--) {
		const entry = ctx.sessionManager.getBranch()[index];
		if (entry.type === "custom" && entry.customType === NAME_ENTRY) {
			const name = (entry.data as { name?: unknown } | undefined)?.name;
			if (typeof name === "string" && name) return name;
		}
	}
	return undefined;
}

export function defaultName(cwd: string): string {
	return `pid-${process.pid}-${basename(cwd)}`.slice(0, 32);
}

export function formatMessage(frame: DeliverFrame): string {
	return `[agent] ${frame.from}${frame.project ? ` (${basename(frame.project)})` : ""}: ${frame.text}`;
}

function ageLabel(connectedAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export function ackText(ack: AckFrame, to: string): string {
	const detail = ack.detail ? ` (${ack.detail})` : "";
	switch (ack.status) {
		case "delivered":
			return `delivered to ${to}${ack.targets ? ` · ${ack.targets} session(s)` : ""}${detail}`;
		case "queued":
			return `queued for offline ${to}${detail}`;
		case "rate_limited":
			return `rate limited: ${to} received too many messages in the last 60s; retry later${detail}`;
		default:
			return `unknown session "${to}"${detail}`;
	}
}

/** Panel styled after the /fleet and /mcp lists: rows + state, escape closes. */
class AgentsPanel {
	private selected = 0;
	private disposed = false;
	private readonly timer: NodeJS.Timeout;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly selfName: string;
	private readonly connected: boolean;
	private readonly rows: readonly SessionInfo[];
	private readonly queued: number;
	private readonly done: (session?: SessionInfo) => void;
	constructor(
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		selfName: string,
		connected: boolean,
		rows: readonly SessionInfo[],
		queued: number,
		done: (session?: SessionInfo) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.selfName = selfName;
		this.connected = connected;
		this.rows = rows;
		this.queued = queued;
		this.done = done;
		this.timer = setInterval(() => {
			if (!this.disposed) this.tui.requestRender();
		}, 1000);
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
	invalidate(): void {}
	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.rows.length === 0) return;
		if (this.kb.matches(data, "tui.select.up"))
			this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
		else if (this.kb.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.rows.length;
		else if (this.kb.matches(data, "tui.select.confirm")) {
			this.done(this.rows[this.selected]);
			return;
		}
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const status = this.connected ? "connected" : "offline";
		const queued = this.queued > 0 ? this.theme.fg("warning", ` · ${this.queued} queued`) : "";
		const lines = [
			`  ${this.theme.fg("accent", this.theme.bold(`Agents · ${status} · this session: ${this.selfName}`))}${queued}`,
			"",
		];
		if (this.rows.length === 0) {
			lines.push(`  ${this.theme.fg("dim", "no other online sessions")}`);
		} else {
			for (const [index, session] of this.rows.entries()) {
				const marker = index === this.selected ? this.theme.fg("accent", "▸") : " ";
				const dot = session.name === this.selfName ? this.theme.fg("muted", "•") : this.theme.fg("success", "●");
				lines.push(
					truncateToWidth(
						`  ${marker} ${dot} ${session.name.padEnd(20)} ${basename(session.project)} · online ${ageLabel(session.connectedAt)}`,
						width,
					),
				);
			}
		}
		lines.push("", `  ${this.theme.fg("dim", "↑/↓ select · Enter action · Escape close")}`);
		return lines;
	}
}

export default function humminAgents(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const config = agentsConfig(cwd);
	if (!config.enabled) return;

	const dir = `${getAgentDir()}/agents`;
	let name = sanitizeName(config.name ?? defaultName(cwd));
	let client: BrokerClient | undefined;
	let server: BrokerServer | undefined;
	let connecting: Promise<void> | undefined;
	let shuttingDown = false;

	const deliver = (frame: DeliverFrame): void => {
		// Incoming text is data, never instructions: render + deliver verbatim.
		pi.sendMessage(
			{ customType: "hummin-agent-message", content: formatMessage(frame), display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const ensureConnected = (): Promise<void> => {
		if (shuttingDown) return Promise.resolve();
		if (client?.connected) return Promise.resolve();
		connecting ??= (async () => {
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						const next = await BrokerClient.connect(dir, {
							sessionId: "",
							name,
							project: cwd,
							pid: process.pid,
						});
						next.onDeliver = deliver;
						next.onClose = () => {
							if (client === next) client = undefined;
							scheduleReconnect();
						};
						client = next;
						return;
					} catch {
						// No live broker: try to become it (stale socket files are rebound).
						server ??= new BrokerServer(dir);
						await server.start();
					}
				}
			} finally {
				connecting = undefined;
			}
		})();
		return connecting;
	};

	let reconnectTimer: NodeJS.Timeout | undefined;
	function scheduleReconnect(): void {
		if (shuttingDown || client?.connected || reconnectTimer) return;
		reconnectTimer = setTimeout(
			() => {
				reconnectTimer = undefined;
				void ensureConnected();
			},
			RECONNECT_INTERVAL_MS,
		);
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return; // Untrusted project: no registration.
		const persisted = persistedName(ctx);
		if (persisted && persisted !== name) {
			name = sanitizeName(persisted);
			client?.close();
			client = undefined;
		}
		await ensureConnected();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		client?.close();
		await server?.close();
	});

	const requireRegistration = async (ctx: { isProjectTrusted: () => boolean }): Promise<BrokerClient | undefined> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project with /trust before using inter-agent messaging");
		await ensureConnected();
		return client?.connected ? client : undefined;
	};

	pi.registerTool({
		name: "agent_send",
		label: "Agent send",
		description:
			"Send a message to another hummin session by exact name, or broadcast with \"@project:<dirName>\" to online sessions of that project. Delivery into the target session is verbatim; do not send instructions expecting auto-execution. Returns delivered/queued/unknown plus latency.",
		promptSnippet:
			"agent_send: message a named session or @project:<dir> broadcast; agent_inbox: list/read/clear offline messages",
		parameters: Type.Object({
			to: Type.String({ minLength: 1, description: "Session name or @project:<dirName> broadcast" }),
			text: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const connection = await requireRegistration(ctx);
			if (!connection) throw new Error("Agents broker unreachable; retry shortly");
			signal?.throwIfAborted();
			const started = Date.now();
			const ack = await connection.send(params.to, params.text);
			signal?.throwIfAborted();
			const latency = `${Date.now() - started}ms`;
			const text = `${ackText(ack, params.to)} · ${latency}`;
			if (ack.status === "delivered") ctx.ui.notify(`agent_send: ${text}`, "info");
			else if (ack.status !== "queued") ctx.ui.notify(`agent_send: ${text}`, "warning");
			return { content: [{ type: "text", text }], details: { status: ack.status, latency } };
		},
	});

	pi.registerTool({
		name: "agent_inbox",
		label: "Agent inbox",
		description:
			"Inspect this session's offline agent inbox. list: pending messages; read: return and drain (default 20, rest stay queued); clear: drop all pending.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("clear")]),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project with /trust before using inter-agent messaging");
			const target = sanitizeName(name);
			if (params.action === "clear") {
				const pending = readInbox(dir, target).length;
				clearInbox(dir, target);
				return { content: [{ type: "text", text: `cleared ${pending} message(s)` }], details: {} };
			}
			if (params.action === "list") {
				const messages = readInbox(dir, target);
				const text =
					messages.length === 0
						? "inbox empty"
						: messages
								.map((message, index) => `${index + 1}. ${message.from}${message.project ? ` (${basename(message.project)})` : ""}: ${message.text}`)
								.join("\n");
				return { content: [{ type: "text", text }], details: { pending: messages.length } };
			}
			const taken = drainInbox(dir, target, params.limit);
			const rest = readInbox(dir, target).length;
			const text =
				taken.length === 0
					? "inbox empty"
					: `${taken.map((message) => formatMessage({ type: "deliver", id: "", ...message })).join("\n")}${rest ? `\n(${rest} still queued)` : ""}`;
			return { content: [{ type: "text", text }], details: { read: taken.length, remaining: rest } };
		},
	});

	pi.registerCommand("agent-name", {
		description: "Set this session's agent registry name (persisted, survives resume)",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(`Current agent name: ${name}\nUsage: /agent-name <name>`, "info");
				return;
			}
			const next = sanitizeName(raw);
			if (next !== raw) ctx.ui.notify(`Name sanitized to "${next}" (allowed: letters, digits, . _ -)`, "warning");
			name = next;
			pi.appendEntry(NAME_ENTRY, { name: next });
			// Re-register under the new name.
			client?.close();
			client = undefined;
			if (ctx.isProjectTrusted()) await ensureConnected();
			ctx.ui.notify(`Agent name set to ${next}`, "info");
		},
	});

	pi.registerCommand("agents", {
		description: "Show online agent sessions and manage the inbox",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Trust this project with /trust before using inter-agent messaging", "warning");
				return;
			}
			await ensureConnected();
			const sessions = client?.connected ? await client.listSessions().catch(() => []) : [];
			const queued = readInbox(dir, sanitizeName(name)).length;
			if (ctx.mode !== "tui") {
				const lines = [
					`this session: ${name} (${client?.connected ? "connected" : "offline"})`,
					queued ? `inbox: ${queued} queued (${inboxPath(dir, name)})` : "inbox: empty",
					...sessions.map((session) => `  ${session.name} · ${basename(session.project)} · online`),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const selected = await ctx.ui.custom<SessionInfo | undefined>(
				(tui, theme, kb, done) =>
					new AgentsPanel(tui, theme, kb, name, Boolean(client?.connected), sessions, queued, done),
			);
			if (!selected) return;
			const action = await ctx.ui.select(`${selected.name} · ${basename(selected.project)}`, [
				"Send message",
				"Rename this session",
				"Clear inbox",
				"Close",
			]);
			if (!action || action === "Close") return;
			if (action === "Rename this session") {
				const input = await ctx.ui.input("New agent name", name);
				if (input?.trim()) {
					const next = sanitizeName(input.trim());
					name = next;
					pi.appendEntry(NAME_ENTRY, { name: next });
					client?.close();
					client = undefined;
					await ensureConnected();
					ctx.ui.notify(`Agent name set to ${next}`, "info");
				}
				return;
			}
			if (action === "Clear inbox") {
				clearInbox(dir, sanitizeName(name));
				ctx.ui.notify("Agent inbox cleared", "info");
				return;
			}
			const text = await ctx.ui.input(`Message to ${selected.name}`);
			if (!text?.trim()) return;
			const connection = await requireRegistration(ctx);
			if (!connection) {
				ctx.ui.notify("Agents broker unreachable", "error");
				return;
			}
			const ack = await connection.send(selected.name, text.trim()).catch((error: unknown) => {
				ctx.ui.notify(`agent send failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			});
			if (ack) ctx.ui.notify(ackText(ack, selected.name), ack.status === "delivered" ? "info" : "warning");
		},
	});
}
