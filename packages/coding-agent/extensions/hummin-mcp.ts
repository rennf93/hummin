/**
 * hummin MCP: Model Context Protocol servers as tool sources (stdio transport).
 *
 * Servers are fleet citizens: configured in settings `mcpServers` (global +
 * project, project wins per name; project servers require project trust),
 * offline servers dim and never register guessed tools, tool descriptions
 * respect compactPrompt (compaction is applied by core to registered tools).
 * Registered tool names stay `mcp_<server>_<tool>` per the standard MCP naming convention.
 */
import { SettingsManager, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { type TSchema } from "typebox";
import {
	MCP_INIT_TIMEOUT_MS,
	MCP_REQUEST_TIMEOUT_MS,
	McpClient,
	type McpClientOptions,
	type McpServerConfig,
	type McpServerState,
	type McpToolInfo,
	mergeMcpServers,
	qualifiedToolName,
	resolveTimeoutMs,
	toolParamsSchema,
} from "./lib/mcp-client.ts";
import { runningProcessCount } from "./lib/processes.ts";

const PROCESS_BUDGET = 8;
const RESTART_TIMEOUT_MS = 15_000;
const INITIAL_CONNECT_ATTEMPTS = 2;
const RECONNECT_BACKOFF_MS = 2_000;

interface ServerEntry {
	name: string;
	config: McpServerConfig;
	client: McpClient;
	registered: Set<string>;
}

/** Read the extension-only `mcpServers` namespace from raw parsed settings. */
function readServers(raw: unknown): Record<string, McpServerConfig> | undefined {
	return (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : undefined) as
		| Record<string, McpServerConfig>
		| undefined;
}

export function configuredServers(cwd: string): Map<string, McpServerConfig> {
	const settings = SettingsManager.create(cwd);
	const global = readServers((settings.getGlobalSettings() as unknown as { mcpServers?: unknown }).mcpServers);
	const project = settings.isProjectTrusted()
		? readServers((settings.getProjectSettings() as unknown as { mcpServers?: unknown }).mcpServers)
		: undefined;
	return mergeMcpServers(global, project);
}

function stateGlyph(state: McpServerState, theme: Theme): string {
	switch (state) {
		case "ready":
			return theme.fg("success", "●");
		case "connecting":
			return theme.fg("muted", "…");
		case "crashed":
		case "error":
			return theme.fg("error", "○");
		case "stopped":
			return theme.fg("dim", "○");
	}
}

export function statusLine(entry: { name: string; state: McpServerState; toolCount: number; error?: string }): string {
	const count = entry.state === "ready" ? `${entry.toolCount} tools` : "offline, no tools";
	const error = entry.error ? ` · ${entry.error.slice(0, 120)}` : "";
	return `${entry.name} (${entry.state}, ${count})${error}`;
}

/** Panel styled after the /fleet server list: selected row, state dots, escape closes. */
class McpPanel {
	private selected = 0;
	private disposed = false;
	private readonly timer: NodeJS.Timeout;
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly kb: KeybindingsManager,
		private readonly entries: readonly ServerEntry[],
		private readonly done: (entry?: ServerEntry) => void,
	) {
		this.timer = setInterval(() => {
			if (!this.disposed) this.tui.requestRender();
		}, 2000);
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
	invalidate(): void {}
	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.done();
		} else if (this.kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected + this.entries.length - 1) % this.entries.length;
		} else if (this.kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % this.entries.length;
		} else if (this.kb.matches(data, "tui.select.confirm")) {
			this.done(this.entries[this.selected]);
			return;
		}
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const ready = this.entries.filter((entry) => entry.client.state === "ready").length;
		const lines = [`  ${this.theme.fg("accent", this.theme.bold(`MCP · ${ready}/${this.entries.length} ready`))}`, ""];
		for (const [index, entry] of this.entries.entries()) {
			const line = `${stateGlyph(entry.client.state, this.theme)} ${entry.name.padEnd(20)} ${statusLine({
				name: entry.name,
				state: entry.client.state,
				toolCount: entry.client.tools.length,
				error: entry.client.error,
			})}`;
			lines.push(truncateToWidth(`  ${index === this.selected ? this.theme.fg("accent", "▸") : " "} ${line}`, width));
		}
		lines.push("", `  ${this.theme.fg("dim", "↑/↓ select · Enter action · Escape close")}`);
		return lines;
	}
}

export default async function humminMcp(pi: ExtensionAPI): Promise<void> {
	if (process.env.HUMMIN_MCP === "0") return;
	const servers = configuredServers(process.cwd());
	const entries = new Map<string, ServerEntry>();

	const registerTools = (entry: ServerEntry, tools: readonly McpToolInfo[], offline: boolean): void => {
		entry.registered.clear();
		for (const tool of tools) {
			const name = qualifiedToolName(entry.name, tool.name);
			const { params, descriptionSuffix } = toolParamsSchema(tool.inputSchema);
			const baseDescription =
				tool.description && tool.description.trim().length > 0 ? tool.description.trim() : `${tool.name} (MCP tool)`;
			const description = `${offline ? "[offline] " : ""}${baseDescription}${descriptionSuffix}`;
			try {
				pi.registerTool({
					name,
					label: `MCP ${entry.name}/${tool.name}`,
					description,
					parameters: params as TSchema,
					async execute(_toolCallId, callParams, signal, _onUpdate, ctx) {
						if (entry.client.state !== "ready") {
							throw new Error(`MCP server ${entry.name} is offline; /mcp to check and restart`);
						}
						signal?.throwIfAborted();
						const result = await entry.client.callTool(tool.name, callParams as Record<string, unknown>, signal);
						const text = McpClient.textOf(result) || "(empty result)";
						if (result.isError) throw new Error(text);
						if (!ctx.hasPendingMessages()) ctx.ui.notify(`${entry.name}/${tool.name} ok`, "info");
						return { content: [{ type: "text", text }], details: {} };
					},
				});
			} catch (error) {
				// A stale ctx (session replaced mid-run) freezes the tool surface;
				// late tools/list_changed notifications must not crash the runtime.
				console.error(`[hummin-mcp] tool ${name} not registered: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			entry.registered.add(name);
		}
	};

	const onCrashed = (name: string): void => {
		const entry = entries.get(name);
		if (entry) registerTools(entry, [], true);
	};
	const onToolsChanged = (name: string, tools: McpToolInfo[]): void => {
		const entry = entries.get(name);
		if (entry && entry.client.state === "ready") registerTools(entry, tools, false);
	};

	const connect = async (entry: ServerEntry): Promise<void> => {
		if (runningProcessCount() >= PROCESS_BUDGET) {
			entry.client.state = "error";
			entry.client.error = `process budget exhausted (${PROCESS_BUDGET} background jobs)`;
			onCrashed(entry.name);
			throw new Error(entry.client.error);
		}
		const tools = await entry.client.connect();
		registerTools(entry, tools, false);
	};

	// Timeouts are env-tunable: fleet images launch MCP children through
	// runtime bootstrappers (uv/venv) whose cold `initialize` legitimately
	// exceeds the built-in default, and gateway verbs can outlast the
	// request default server-side.
	const clientOptions = (name: string): McpClientOptions => ({
		initTimeoutMs: resolveTimeoutMs(process.env.HUMMIN_MCP_INIT_TIMEOUT_MS, MCP_INIT_TIMEOUT_MS),
		requestTimeoutMs: resolveTimeoutMs(process.env.HUMMIN_MCP_REQUEST_TIMEOUT_MS, MCP_REQUEST_TIMEOUT_MS),
		onStateChange: (state) => {
			if (state === "crashed" || state === "error") onCrashed(name);
		},
		onToolsChanged: (tools) => onToolsChanged(name, tools),
	});

	const declareUnavailable = (name: string, error: unknown): void => {
		onCrashed(name);
		const detail = error instanceof Error ? error.message : String(error);
		// stderr is the durable record: headless runs (--mode json) may have
		// replaced their session by the time a server fails, which stale-poisons
		// this captured ctx and makes the followUp message throw.
		console.error(`[hummin-mcp] server ${name} unavailable: ${detail}`);
		try {
			pi.sendMessage(
				{
					customType: "hummin-mcp",
					content: `MCP server ${name} unavailable: ${detail}. Tools not registered; /mcp to restart.`,
					display: true,
				},
				{ deliverAs: "followUp" },
			);
		} catch {
			// stale ctx - the stderr line above already recorded the failure
		}
	};

	// One connect attempt against a fresh client: a timed-out attempt may
	// still own a slow child, so restart semantics mirror /mcp (stop the old
	// client, never reuse it).
	const attemptConnect = async (entry: ServerEntry): Promise<void> => {
		const previous = entry.client;
		entry.client = new McpClient(entry.name, entry.config, clientOptions(entry.name));
		await previous.stop().catch(() => undefined);
		await connect(entry);
	};

	// Register before connect so state callbacks can find the entry. The
	// connects run to completion INSIDE the extension factory: MCP tools must
	// register while this extension's context is fresh. A handshake that lands
	// after the session rebinds hits a stale ctx and every registered tool is
	// silently lost (proven on the wire in headless --mode json: clean
	// handshake, all tools listed, then "extension ctx is stale" on
	// registration). Awaiting here costs server boot time at startup and
	// puts the full verb surface in the model's hands from turn one.
	const connectRuns: Promise<void>[] = [];
	for (const [name, config] of servers) {
		const entry: ServerEntry = {
			name,
			config,
			client: new McpClient(name, config, clientOptions(name)),
			registered: new Set<string>(),
		};
		entries.set(name, entry);
		connectRuns.push(
			(async () => {
				for (let attempt = 1; ; attempt++) {
					try {
						await attemptConnect(entry);
						return;
					} catch (error) {
						if (attempt >= INITIAL_CONNECT_ATTEMPTS) {
							declareUnavailable(name, error);
							return;
						}
						await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));
					}
				}
			})(),
		);
	}
	await Promise.allSettled(connectRuns);

	// Best-effort shutdown of all servers at session end (exact PIDs only).
	pi.on("session_shutdown", async () => {
		await Promise.all([...entries.values()].map((entry) => entry.client.stop().catch(() => undefined)));
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status and restart servers",
		handler: async (_args, ctx) => {
			const list = [...entries.values()];
			if (list.length === 0) {
				ctx.ui.notify(
					"No MCP servers configured. Add settings key `mcpServers` ({name: {command, args?, env?, cwd?}}) to global or project settings.",
					"info",
				);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					["MCP servers:", ...list.map((entry) =>
						statusLine({
							name: entry.name,
							state: entry.client.state,
							toolCount: entry.client.tools.length,
							error: entry.client.error,
						}),
					)].join("\n"),
					"info",
				);
				return;
			}
			for (;;) {
				const selected = await ctx.ui.custom<ServerEntry | undefined>(
					(tui, theme, kb, done) => new McpPanel(tui, theme, kb, list, done),
				);
				if (!selected) return;
				const action = await ctx.ui.select(`${selected.name} (${selected.client.state})`, ["Restart", "Close"]);
				if (action !== "Restart") return;
				const previous = selected.client;
				selected.client = new McpClient(selected.name, selected.config, clientOptions(selected.name));
				try {
					await previous.stop();
					await Promise.race([
						connect(selected),
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error(`restart timed out after ${RESTART_TIMEOUT_MS}ms`)), RESTART_TIMEOUT_MS),
						),
					]);
					ctx.ui.notify(`${selected.name}: ready (${selected.client.tools.length} tools)`, "info");
				} catch (error) {
					ctx.ui.notify(
						`${selected.name}: restart failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			}
		},
	});
}
