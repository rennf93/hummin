/**
 * Hand-rolled LSP (Language Server Protocol) client over stdio — TypeScript/
 * JavaScript servers via `typescript-language-server` in v1.
 *
 * JSON-RPC 2.0 using the LSP base protocol: `Content-Length` header framing
 * on stdio (unlike MCP's newline-delimited frames, but the same structural
 * pattern as lib/mcp-client.ts: spawn, pending-request map, timeouts,
 * server-initiated messages tolerated). Pure Node: no extension API, no npm
 * deps — unit testable. Every spawned child gets HUMMIN_MEMORY=0; budget
 * enforcement against the shared ProcessManager limit lives in the extension.
 *
 * Content sync (v1 simplification): files are opened lazily on first use, and
 * each subsequent tool call does didClose + didOpen with a fresh read of the
 * file from disk instead of incremental didChange syncing. This is one extra
 * open per call, but it cannot drift from on-disk state and avoids range
 * bookkeeping entirely. Revisit only if didOpen/didClose chattiness matters.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const LSP_INIT_TIMEOUT_MS = 10_000;
export const LSP_REQUEST_TIMEOUT_MS = 10_000;

export interface LspServerConfig {
	command: string;
	args?: string[];
	cwd?: string;
}

export type LspServerState = "stopped" | "connecting" | "ready" | "crashed" | "error";

export interface LspDiagnostic {
	uri: string;
	/** 0-based line. */
	line: number;
	/** 0-based character. */
	character: number;
	/** LSP severity 1..4 (error, warning, information, hint). */
	severity: number;
	message: string;
	source?: string;
}

export interface LspLocation {
	uri: string;
	line: number;
	character: number;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface LspClientOptions {
	initTimeoutMs?: number;
	requestTimeoutMs?: number;
	onStateChange?: (state: LspServerState, error?: string) => void;
	/** Called whenever a textDocument/publishDiagnostics notification arrives. */
	onDiagnostics?: (uri: string, diagnostics: LspDiagnostic[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tool params are 1-based; LSP positions are 0-based. Clamps to >= 0. */
export function toLspPosition(line: number, character: number): { line: number; character: number } {
	return { line: Math.max(0, Math.floor(line) - 1), character: Math.max(0, Math.floor(character) - 1) };
}

const SEVERITY_NAMES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function formatSeverity(severity: number): string {
	return SEVERITY_NAMES[severity] ?? "info";
}

/** Format diagnostics as `line:col severity message` lines (1-based display). */
export function formatDiagnostics(diagnostics: readonly LspDiagnostic[]): string[] {
	return diagnostics.map((d) => `${d.line + 1}:${d.character + 1} ${formatSeverity(d.severity)} ${d.message}`);
}

/** Extract plain text from a hover result (`MarkupContent`, marked strings, or arrays). */
export function hoverText(hover: unknown): string {
	if (!isRecord(hover)) return "";
	const contents = hover.contents;
	const markedString = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (isRecord(value) && typeof value.value === "string") return value.value;
		return "";
	};
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(markedString).filter(Boolean).join("\n");
	return markedString(contents);
}

export function uriToPath(uri: string): string {
	return fileURLToPath(uri);
}

/** Absolute path for a tool `path` param (resolved against the project cwd). */
export function resolvePath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export function pathToUri(path: string): string {
	return pathToFileURL(path).href;
}

/** Language identifier for didOpen, from file extension. */
export function languageIdFor(path: string): string {
	if (path.endsWith(".tsx")) return "typescriptreact";
	if (path.endsWith(".jsx")) return "javascriptreact";
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
	return "javascript";
}

/** One stdio LSP server connection. Owns only its directly spawned child. */
export class LspClient {
	readonly name: string;
	readonly config: LspServerConfig;
	state: LspServerState = "stopped";
	error?: string;
	serverCapabilities?: Record<string, unknown>;

	private readonly initTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly onStateChange?: LspClientOptions["onStateChange"];
	private readonly onDiagnostics?: LspClientOptions["onDiagnostics"];
	private child: ChildProcess | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private buffer = "";
	private stderrTail = "";
	private connecting: Promise<void> | undefined;
	private stopped = false;
	private version = 0;
	/** URIs currently open on the server (didOpen sent). */
	private readonly openUris = new Set<string>();
	/** Latest publishDiagnostics per URI. */
	private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>();

	constructor(name: string, config: LspServerConfig, options: LspClientOptions = {}) {
		this.name = name;
		this.config = config;
		this.initTimeoutMs = options.initTimeoutMs ?? LSP_INIT_TIMEOUT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS;
		this.onStateChange = options.onStateChange;
		this.onDiagnostics = options.onDiagnostics;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** Diagnostics snapshot: one URI's entries, or all open files. */
	getDiagnostics(uri?: string): Map<string, LspDiagnostic[]> {
		if (uri !== undefined) {
			const found = this.diagnosticsByUri.get(uri);
			return new Map(found ? [[uri, found]] : []);
		}
		return new Map(this.diagnosticsByUri);
	}

	/** Connect (initialize handshake). Idempotent: repeat calls share one handshake. */
	connect(): Promise<void> {
		if (this.connecting) return this.connecting;
		this.connecting = this.doConnect().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private setState(state: LspServerState, error?: string): void {
		this.state = state;
		this.error = error;
		try {
			this.onStateChange?.(state, error);
		} catch {
			// observer errors must not break the transport
		}
	}

	private async doConnect(): Promise<void> {
		if (this.state === "ready") return;
		if (this.stopped) throw new Error(`LSP server ${this.name} is stopped`);
		this.setState("connecting");
		const child = spawn(this.config.command, this.config.args ?? [], {
			cwd: this.config.cwd,
			env: { ...process.env, HUMMIN_MEMORY: "0" },
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
		child.once("error", (err: Error) => crash(`LSP server ${this.name} failed to spawn: ${err.message}`));
		child.once("exit", (code, signalName) =>
			crash(`LSP server ${this.name} exited (code ${code ?? "none"}, signal ${signalName ?? "none"})`),
		);
		try {
			const result = await this.request(
				"initialize",
				{
					processId: process.pid,
					capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
					rootUri: this.config.cwd ? pathToFileURL(this.config.cwd).href : undefined,
				},
				undefined,
				this.initTimeoutMs,
			);
			this.serverCapabilities = isRecord(result) && isRecord(result.capabilities) ? result.capabilities : {};
			this.notify("initialized", {});
			this.setState("ready");
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			throw new Error(this.error);
		}
	}

	/** didOpen (or close+reopen) a file from disk; returns its URI. */
	syncOpen(filePath: string): string {
		const text = readFileSync(filePath, "utf8");
		const uri = pathToUri(filePath);
		this.version++;
		if (this.openUris.has(uri)) {
			this.notify("textDocument/didClose", { textDocument: { uri } });
			this.openUris.delete(uri);
		}
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: languageIdFor(filePath), version: this.version, text },
		});
		this.openUris.add(uri);
		return uri;
	}

	async definition(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<LspLocation[]> {
		const result = await this.request(
			"textDocument/definition",
			{ textDocument: { uri: pathToUri(filePath) }, position: toLspPosition(line, character) },
			signal,
		);
		return normalizeLocations(result);
	}

	async references(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration = false,
		signal?: AbortSignal,
	): Promise<LspLocation[]> {
		const result = await this.request(
			"textDocument/references",
			{
				textDocument: { uri: pathToUri(filePath) },
				position: toLspPosition(line, character),
				context: { includeDeclaration },
			},
			signal,
		);
		return normalizeLocations(result);
	}

	async hover(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<string> {
		const result = await this.request(
			"textDocument/hover",
			{ textDocument: { uri: pathToUri(filePath) }, position: toLspPosition(line, character) },
			signal,
		);
		return hoverText(result);
	}

	/** Stop the server (exact child PID, SIGTERM then SIGKILL after a delay). */
	async stop(): Promise<void> {
		this.stopped = true;
		const child = this.child;
		this.rejectAll("stopped");
		this.openUris.clear();
		this.diagnosticsByUri.clear();
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

	/** Mark offline, reject every pending request, drop diagnostics. */
	private fail(message: string): void {
		if (this.state === "crashed" || this.state === "error" || this.state === "stopped") return;
		this.rejectAll(message);
		this.openUris.clear();
		this.diagnosticsByUri.clear();
		this.setState("crashed", message);
	}

	private rejectAll(message: string): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error(message));
		}
		this.pending.clear();
	}

	private request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed)
			return Promise.reject(new Error(`LSP server ${this.name} is offline (${this.state})`));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP ${this.name} ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const onAbort = () => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`LSP ${this.name} ${method} aborted`));
			};
			if (signal) {
				if (signal.aborted) {
					clearTimeout(timer);
					reject(new Error(`LSP ${this.name} ${method} aborted`));
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
			this.sendFrame({ jsonrpc: "2.0", id, method, params }, (writeError) => {
				if (writeError) {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(new Error(`LSP server ${this.name} is offline (${this.state}): ${writeError.message}`));
				}
			});
		});
	}

	private notify(method: string, params?: unknown): void {
		this.sendFrame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	private sendFrame(frame: unknown, callback?: (error?: Error | null) => void): void {
		const stdin = this.child?.stdin;
		if (!stdin) return;
		const body = JSON.stringify(frame);
		stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, callback);
	}

	/** Feed raw stdout into the Content-Length framed JSON-RPC dispatcher. */
	private receive(chunk: string): void {
		this.buffer = (this.buffer + chunk).slice(-1_000_000);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.slice(0, headerEnd);
			const lengthMatch = /Content-Length: (\d+)/i.exec(header);
			if (!lengthMatch) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const length = Number(lengthMatch[1]);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length - bodyStart < length) return; // wait for the rest
			const body = this.buffer.slice(bodyStart, bodyStart + length);
			this.buffer = this.buffer.slice(bodyStart + length);
			try {
				this.dispatch(JSON.parse(body));
			} catch {
				// malformed body: skip
			}
		}
	}

	private dispatch(frame: unknown): void {
		if (!isRecord(frame)) return;
		if (typeof frame.method === "string") {
			const id = typeof frame.id === "number" ? frame.id : typeof frame.id === "string" ? Number(frame.id) : undefined;
			if (id !== undefined && !Number.isNaN(id)) {
				// Server-initiated request (workspace/configuration, window/...):
				// answer MethodNotFound so the server never blocks on us.
				this.sendFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			} else if (frame.method === "textDocument/publishDiagnostics") {
				const params = frame.params;
				const diagUri = isRecord(params) && typeof params.uri === "string" ? params.uri : undefined;
				if (diagUri !== undefined && isRecord(params) && Array.isArray(params.diagnostics)) {
					const diagnostics = params.diagnostics.filter(isRecord).map((d) => {
						const range = isRecord(d.range) && isRecord(d.range.start) ? d.range.start : {};
						return {
							uri: diagUri,
							line: typeof range.line === "number" ? range.line : 0,
							character: typeof range.character === "number" ? range.character : 0,
							severity: typeof d.severity === "number" ? d.severity : 3,
							message: typeof d.message === "string" ? d.message : "",
							...(typeof d.source === "string" ? { source: d.source } : {}),
						};
					});
					this.diagnosticsByUri.set(diagUri, diagnostics);
					try {
						this.onDiagnostics?.(diagUri, diagnostics);
					} catch {
						// observer errors must not break the transport
					}
				}
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
			request.reject(new Error(`LSP ${this.name} error: ${message}`));
		} else {
			request.resolve(frame.result);
		}
	}
}

function normalizeLocations(result: unknown): LspLocation[] {
	const fromRecord = (value: unknown): LspLocation | undefined => {
		if (!isRecord(value)) return undefined;
		const range = isRecord(value.range) ? value.range : value;
		const start = isRecord(range.start) ? range.start : {};
		if (typeof value.uri !== "string") return undefined;
		return {
			uri: value.uri,
			line: typeof start.line === "number" ? start.line : 0,
			character: typeof start.character === "number" ? start.character : 0,
		};
	};
	if (Array.isArray(result)) return result.map(fromRecord).filter((loc): loc is LspLocation => loc !== undefined);
	const single = fromRecord(result);
	return single ? [single] : [];
}
