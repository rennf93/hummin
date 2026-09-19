/**
 * Hand-rolled MCP (Model Context Protocol) client over stdio.
 *
 * Newline-delimited JSON-RPC 2.0 against a spawned `command args...` child.
 * Pure Node: no extension API, no npm deps — unit testable. Every spawned
 * child gets HUMMIN_MEMORY=0; budget enforcement against the shared
 * ProcessManager limit lives in the extension (this module stays transport-only).
 */
import { type ChildProcess, spawn } from "node:child_process";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_INIT_TIMEOUT_MS = 10_000;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;

/** De-facto standard config shape: settings `mcpServers[name]`. */
export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	/** Raw JSON Schema from the server, when provided. */
	inputSchema?: unknown;
}

export type McpServerState = "stopped" | "connecting" | "ready" | "crashed" | "error";

export interface McpContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface McpCallResult {
	content: McpContentBlock[];
	isError: boolean;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercase and collapse a server/tool name to [a-z0-9_] for `mcp_<server>_<tool>`. */
export function sanitizeToolPart(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
}

/** `mcp_<server>_<tool>` with sanitized parts (standard MCP naming convention). */
export function qualifiedToolName(server: string, tool: string): string {
	return `mcp_${sanitizeToolPart(server)}_${sanitizeToolPart(tool)}`;
}

/** Merge global + project `mcpServers`: project wins per name. */
export function mergeMcpServers(
	global: Record<string, McpServerConfig> | undefined,
	project: Record<string, McpServerConfig> | undefined,
): Map<string, McpServerConfig> {
	const merged = new Map<string, McpServerConfig>();
	for (const [name, config] of Object.entries(global ?? {})) {
		if (isRecord(config) && typeof config.command === "string") merged.set(name, normalizeConfig(config));
	}
	for (const [name, config] of Object.entries(project ?? {})) {
		if (isRecord(config) && typeof config.command === "string") merged.set(name, normalizeConfig(config));
	}
	return merged;
}

function normalizeConfig(config: Record<string, unknown>): McpServerConfig {
	const command = config.command;
	if (typeof command !== "string") throw new Error("mcp server config requires a string command");
	const out: McpServerConfig = { command };
	if (typeof config.cwd === "string") out.cwd = config.cwd;
	if (Array.isArray(config.args)) {
		out.args = config.args.filter((arg): arg is string => typeof arg === "string");
	}
	if (isRecord(config.env)) {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(config.env)) if (typeof value === "string") env[key] = value;
		out.env = env;
	}
	return out;
}

/** True when the schema is a JSON Schema object we can hand to TypeBox unchanged. */
export function isObjectSchema(schema: unknown): schema is { type: "object"; properties?: unknown; required?: unknown } {
	return isRecord(schema) && schema.type === "object" && isRecord(schema.properties ?? {});
}

/** Parameter schema for pi.registerTool: pass through valid object schemas,
 * otherwise a plain object schema with the raw JSON embedded in the description. */
export function toolParamsSchema(inputSchema: unknown): { params: Record<string, unknown>; descriptionSuffix: string } {
	if (isObjectSchema(inputSchema)) {
		return { params: inputSchema as unknown as Record<string, unknown>, descriptionSuffix: "" };
	}
	const raw = inputSchema === undefined ? "" : JSON.stringify(inputSchema);
	return {
		params: { type: "object", properties: {}, required: [] },
		descriptionSuffix: raw ? `\n\nInput schema (opaque to this client): ${raw}` : "",
	};
}

export interface McpClientOptions {
	initTimeoutMs?: number;
	requestTimeoutMs?: number;
	/** Called on state transitions (ready/crashed/error/stopped). */
	onStateChange?: (state: McpServerState, error?: string) => void;
	/** Called after tools were refreshed (connect or notifications/tools/list_changed). */
	onToolsChanged?: (tools: McpToolInfo[]) => void;
}

/** One stdio MCP server connection. Owns only its directly spawned child. */
export class McpClient {
	readonly name: string;
	readonly config: McpServerConfig;
	state: McpServerState = "stopped";
	tools: McpToolInfo[] = [];
	error?: string;

	private readonly initTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly onStateChange?: McpClientOptions["onStateChange"];
	private readonly onToolsChanged?: McpClientOptions["onToolsChanged"];
	private child: ChildProcess | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private buffer = "";
	private stderrTail = "";
	private connecting: Promise<McpToolInfo[]> | undefined;
	private stopped = false;

	constructor(name: string, config: McpServerConfig, options: McpClientOptions = {}) {
		this.name = name;
		this.config = config;
		this.initTimeoutMs = options.initTimeoutMs ?? MCP_INIT_TIMEOUT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
		this.onStateChange = options.onStateChange;
		this.onToolsChanged = options.onToolsChanged;
	}

	/** Connect (initialize handshake) and return the server's tool list.
	 * Idempotent: concurrent/ repeat calls share one handshake. */
	connect(): Promise<McpToolInfo[]> {
		if (this.connecting) return this.connecting;
		this.connecting = this.doConnect().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private setState(state: McpServerState, error?: string): void {
		this.state = state;
		this.error = error;
		try {
			this.onStateChange?.(state, error);
		} catch {
			// observer errors must not break the transport
		}
	}

	private async doConnect(): Promise<McpToolInfo[]> {
		if (this.state === "ready") return this.tools;
		if (this.stopped) throw new Error(`MCP server ${this.name} is stopped`);
		this.setState("connecting");
		const child = spawn(this.config.command, this.config.args ?? [], {
			cwd: this.config.cwd,
			env: { ...process.env, ...this.config.env, HUMMIN_MEMORY: "0" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.buffer = "";
		this.stderrTail = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.receive(chunk));
		const crash = (message: string) => {
			const error = this.stderrTail.trim() ? `${message}: ${this.stderrTail.trim().slice(-500)}` : message;
			this.fail(error);
		};
		child.once("error", (err: Error) => crash(`MCP server ${this.name} failed to spawn: ${err.message}`));
		child.once("exit", (code, signalName) =>
			crash(`MCP server ${this.name} exited (code ${code ?? "none"}, signal ${signalName ?? "none"})`),
		);
		try {
			await this.request("initialize", {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "hummin", version: "1.0.0" },
			}, this.initTimeoutMs);
			this.notify("notifications/initialized");
			await this.refreshTools();
			this.setState("ready");
			return this.tools;
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			throw new Error(this.error);
		}
	}

	/** Re-fetch tools/list (initial connect and list_changed notifications). */
	async refreshTools(): Promise<McpToolInfo[]> {
		const result = await this.request("tools/list", {});
		const toolsRaw = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
		this.tools = toolsRaw.filter(isRecord).map((tool) => ({
			name: typeof tool.name === "string" ? tool.name : "",
			description: typeof tool.description === "string" ? tool.description : undefined,
			inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
		}));
		try {
			this.onToolsChanged?.(this.tools);
		} catch {
			// observer errors must not break the transport
		}
		return this.tools;
	}

	/** Call a server tool. Honors AbortSignal for the caller side. */
	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		const result = (await this.request("tools/call", { name: tool, arguments: args }, this.requestTimeoutMs, signal)) as Record<
			string,
			unknown
		>;
		const contentRaw = Array.isArray(result?.content) ? result.content : [];
		const content = contentRaw.filter(isRecord).map((block) => ({ type: String(block.type ?? "text"), ...block }));
		return { content, isError: result?.isError === true };
	}

	/** Text of a tools/call result, joined. */
	static textOf(result: McpCallResult): string {
		return result.content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	}

	/** Stop the server (exact child PID, SIGTERM then SIGKILL after a delay). */
	async stop(): Promise<void> {
		this.stopped = true;
		const child = this.child;
		this.rejectAll("stopped");
		this.tools = [];
		this.setState("stopped");
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 1500);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	/** Mark offline, reject every pending request, drop tools (never guessed). */
	private fail(message: string): void {
		if (this.state === "crashed" || this.state === "error" || this.state === "stopped") return;
		this.rejectAll(message);
		this.tools = [];
		this.setState("crashed", message);
		try {
			this.onToolsChanged?.(this.tools);
		} catch {
			// ignore observer errors
		}
	}

	private rejectAll(message: string): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error(message));
		}
		this.pending.clear();
	}

	private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs, signal?: AbortSignal): Promise<unknown> {
		const child = this.child;
		if (!child || !child.stdin || child.stdin.destroyed)
			return Promise.reject(new Error(`MCP server ${this.name} is offline (${this.state})`));
		const id = this.nextId++;
		const frame = { jsonrpc: "2.0", id, method, params };
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP ${this.name} ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const onAbort = () => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`MCP ${this.name} ${method} aborted`));
			};
			if (signal) {
				if (signal.aborted) {
					clearTimeout(timer);
					reject(new Error(`MCP ${this.name} ${method} aborted`));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			child.stdin!.write(`${JSON.stringify(frame)}\n`, (writeError) => {
				if (writeError) {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(new Error(`MCP server ${this.name} is offline (${this.state}): ${writeError.message}`));
				}
			});
		});
	}

	private notify(method: string, params?: unknown): void {
		const child = this.child;
		if (!child?.stdin) return;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
	}

	/** Feed raw stdout into the line-delimited JSON-RPC dispatcher. */
	private receive(chunk: string): void {
		this.buffer = (this.buffer + chunk).slice(-1_000_000);
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let frame: unknown;
			try {
				frame = JSON.parse(line);
			} catch {
				continue; // non-JSON line: ignore
			}
			this.dispatch(frame);
		}
	}

	private dispatch(frame: unknown): void {
		if (!isRecord(frame)) return;
		if (typeof frame.method === "string" && frame.id === undefined) {
			if (frame.method === "notifications/tools/list_changed" && this.state === "ready") {
				void this.refreshTools().catch(() => {
					// refresh failure keeps the previous list; crash path handles exit
				});
			}
			return; // other server notifications ignored (v1)
		}
		const id = typeof frame.id === "number" ? frame.id : typeof frame.id === "string" ? Number(frame.id) : undefined;
		if (id === undefined || Number.isNaN(id)) return;
		const request = this.pending.get(id);
		if (!request) return;
		this.pending.delete(id);
		clearTimeout(request.timer);
		if (isRecord(frame.error)) {
			const message = typeof frame.error.message === "string" ? frame.error.message : JSON.stringify(frame.error);
			request.reject(new Error(`MCP ${this.name} error: ${message}`));
		} else {
			request.resolve(frame.result);
		}
	}
}
