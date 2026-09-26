/**
 * hummin LSP: compiler-grade intel for the agent via a language server (v1:
 * TypeScript/JavaScript only, via `typescript-language-server` when present
 * on PATH).
 *
 * Auto-activates when the project has tsconfig.json or jsconfig.json and the
 * server binary is available. `HUMMIN_LSP=0` or settings `lsp.enabled: false`
 * disables. Settings namespace `lsp: { enabled?, typescript?: { command?,
 * args? } }` (project wins over global; project settings require trust).
 *
 * Tools are registered only while the server is ready. On a server crash the
 * tool names are re-registered as offline stubs that fail with an actionable
 * message (the harness has no unregister API; this mirrors hummin-mcp).
 * Offline stub calls are appended to the friction log (lib/friction.ts).
 * One-time notify on crash via a followUp session message.
 *
 * Push channel: after a successful edit or write to a TS/JS file, the tool
 * result gets the file's diagnostics appended (bounded wait, never errors).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	SettingsManager,
	type ExtensionAPI,
	type ToolResultEvent,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { appendFriction } from "./lib/friction.ts";
import {
	LspClient,
	type LspLocation,
	type LspServerConfig,
	pathToUri,
	uriToPath,
} from "./lib/lsp-client.ts";
import { runningProcessCount } from "./lib/processes.ts";

const execFileAsync = promisify(execFile);
const PROCESS_BUDGET = 8;

interface LspSettings {
	enabled?: boolean;
	typescript?: { command?: string; args?: string[] };
}

function readSettings(raw: unknown): LspSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const out: LspSettings = {};
	if (typeof record.enabled === "boolean") out.enabled = record.enabled;
	if (typeof record.typescript === "object" && record.typescript !== null) {
		const ts = record.typescript as Record<string, unknown>;
		out.typescript = {};
		if (typeof ts.command === "string") out.typescript.command = ts.command;
		if (Array.isArray(ts.args)) out.typescript.args = ts.args.filter((arg): arg is string => typeof arg === "string");
	}
	return out;
}

/** Effective config for a project cwd: env beats project settings beats global. */
function resolveConfig(cwd: string): { enabled: boolean; config: LspServerConfig } {
	const settings = SettingsManager.create(cwd);
	const global = readSettings(settings.getGlobalSettings());
	const project = settings.isProjectTrusted() ? readSettings(settings.getProjectSettings()) : {};
	const enabled = process.env.HUMMIN_LSP === "0" ? false : (project.enabled ?? global.enabled ?? true);
	const typescript = project.typescript ?? global.typescript ?? {};
	return {
		enabled,
		config: {
			command: typescript.command ?? "typescript-language-server",
			args: typescript.args ?? ["--stdio"],
			cwd,
		},
	};
}

async function probeBinary(command: string): Promise<boolean> {
	try {
		await execFileAsync("which", [command]);
		return true;
	} catch {
		return false;
	}
}

const INSTALL_HINT = "npm i -g typescript typescript-language-server";

/** File extensions whose edit/write results get diagnostics appended. */
const DIAGNOSTICS_PUSH_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
/** Total budget for the wait on a publishDiagnostics push after an edit or write. */
export const DIAGNOSTICS_PUSH_WAIT_MS = 1_500;
/** Most severe diagnostics appended to a tool result; the rest collapse into a hint line. */
export const DIAGNOSTICS_PUSH_MAX_LINES = 8;

/** The slice of LspClient the push channel relies on (fakes provide this in tests). */
type DiagnosticsPushClient = Pick<LspClient, "state" | "syncOpen" | "waitForDiagnostics">;

/**
 * tool_result push channel: after a successful edit or write to a TS/JS file,
 * didOpen the file (fresh read from disk, so post-edit content) and wait a
 * bounded time for the language server to publish diagnostics, then append
 * them to the tool result. Errors are listed before warnings and the list is
 * capped at DIAGNOSTICS_PUSH_MAX_LINES. A URI with no entry after the wait
 * means the server did not report (e.g. a cold project still loading), which
 * is reported as such instead of being confused with a clean file. Never
 * modifies the result on any failure: not a TS/JS path, server not ready,
 * syncOpen throws, or the wait times out all return undefined.
 */
export function createDiagnosticsPushHandler(deps: {
	getClient: () => DiagnosticsPushClient | undefined;
	cwd: string;
	waitMs?: number;
}): (event: ToolResultEvent) => Promise<ToolResultEventResult | undefined> {
	const waitMs = deps.waitMs ?? DIAGNOSTICS_PUSH_WAIT_MS;
	return async (event) => {
		try {
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			if (event.isError) return undefined;
			const rawPath = event.input.path;
			if (typeof rawPath !== "string" || !DIAGNOSTICS_PUSH_EXTENSIONS.test(rawPath)) return undefined;
			const client = deps.getClient();
			if (!client || client.state !== "ready") return undefined;
			const filePath = rawPath.startsWith("/") ? rawPath : resolve(deps.cwd, rawPath);
			client.syncOpen(filePath);
			const diagnostics = await client.waitForDiagnostics(pathToUri(filePath), waitMs);
			const block = (text: string): NonNullable<ToolResultEventResult["content"]>[number] => ({
				type: "text",
				text,
			});
			if (!diagnostics) {
				return {
					content: [...event.content, block(`LSP diagnostics for ${rawPath}: unavailable (server did not report)`)],
				};
			}
			if (diagnostics.length === 0) {
				return { content: [...event.content, block(`LSP diagnostics for ${rawPath}: none`)] };
			}
			const ordered = [...diagnostics].sort((a, b) => a.severity - b.severity);
			const lines = formatDiagLines(ordered.slice(0, DIAGNOSTICS_PUSH_MAX_LINES));
			if (ordered.length > DIAGNOSTICS_PUSH_MAX_LINES) {
				lines.push(`+${ordered.length - DIAGNOSTICS_PUSH_MAX_LINES} more (lsp_diagnostics for all)`);
			}
			return { content: [...event.content, block([`LSP diagnostics for ${rawPath}:`, ...lines].join("\n"))] };
		} catch {
			return undefined;
		}
	};
}

/** One language-server connection plus its registered tool names. */
interface LspEntry {
	client: LspClient;
	config: LspServerConfig;
	registered: Set<string>;
	notifiedCrash: boolean;
}

export default function humminLsp(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const { enabled, config } = resolveConfig(cwd);
	const isTsProject = existsSync(join(cwd, "tsconfig.json")) || existsSync(join(cwd, "jsconfig.json"));
	let entry: LspEntry | undefined;

	const serverStatus = (): string => {
		if (!enabled) return "disabled (HUMMIN_LSP=0 or lsp.enabled: false)";
		if (!isTsProject) return "inactive: no tsconfig.json/jsconfig.json in this project";
		if (!entry) return `${config.command}: not running`;
		return `${config.command} (${entry.client.state}${entry.client.error ? `: ${entry.client.error}` : ""})`;
	};

	const statusText = (): string => {
		const lines = [`LSP server: ${serverStatus()}`];
		if (!entry) {
			if (enabled && isTsProject) lines.push(`If the server is missing, install with: ${INSTALL_HINT}`);
			return lines.join("\n");
		}
		const client = entry.client;
		lines.push(`pid: ${client.pid ?? "none"}`);
		const all = client.getDiagnostics();
		let total = 0;
		for (const diags of all.values()) total += diags.length;
		lines.push(`open files: ${all.size} · diagnostics: ${total}`);
		for (const [uri, diags] of all) {
			const errors = diags.filter((d) => d.severity === 1).length;
			const warnings = diags.filter((d) => d.severity === 2).length;
			lines.push(`  ${uriToPath(uri)}: ${diags.length} (${errors} errors, ${warnings} warnings)`);
		}
		return lines.join("\n");
	};

	/** Register live tools (server ready) or offline stubs after a crash. */
	const registerTools = (current: LspEntry, ready: boolean): void => {
		current.registered.clear();
		const offline = (tool: string): never => {
			appendFriction({ kind: "lsp_stub", source: "lsp", detail: `${current.config.command}/${tool}` });
			throw new Error(`[LSP] language server is offline; ${tool} unavailable. /lsp to check and restart`);
		};
		const requireReady = (tool: string): void => {
			if (!ready || current.client.state !== "ready") offline(tool);
		};
		/** Lazy didOpen; close+reopen on every call is the v1 content-sync policy. */
		const openTarget = (tool: string, path: string): { filePath: string } => {
			requireReady(tool);
			const filePath = path.startsWith("/") ? path : resolve(cwd, path);
			current.client.syncOpen(filePath);
			return { filePath };
		};
		const finish = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
		const locationsText = (label: string, locations: LspLocation[]): string => {
			if (locations.length === 0) return `${label}: no results`;
			return [
				`${label} (${locations.length}):`,
				...locations.map((loc) => `${uriToPath(loc.uri)}:${loc.line + 1}:${loc.character + 1}`),
			].join("\n");
		};
		const positionDescriptionSuffix = ready ? " Coordinates are 1-based." : "";

		interface ToolSpec {
			name: string;
			description: string;
			parameters: TSchema;
			execute: (
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
			) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }>;
		}

		const specs: ToolSpec[] = [
			{
				name: "lsp_diagnostics",
				description: ready
					? "Compiler-grade diagnostics from the TypeScript language server. Omit path for all open files. Prefer this over running tsc to check code."
					: "TypeScript diagnostics (language server offline)",
				parameters: Type.Object({
					path: Type.Optional(Type.String({ description: "File path (absolute or project-relative)" })),
				}),
				async execute(params, signal) {
					requireReady("lsp_diagnostics");
					signal?.throwIfAborted();
					const path = typeof params.path === "string" ? params.path : undefined;
					if (path) {
						const filePath = path.startsWith("/") ? path : resolve(cwd, path);
						const uri = pathToUri(filePath);
						if (!current.client.getDiagnostics(uri).has(uri)) current.client.syncOpen(filePath);
						const diags = current.client.getDiagnostics(uri).get(uri) ?? [];
						return finish(
							diags.length === 0
								? `${filePath}: no diagnostics`
								: [`${filePath}:`, ...formatDiagLines(diags)].join("\n"),
						);
					}
					const all = current.client.getDiagnostics();
					if (all.size === 0) return finish("No diagnostics for open files");
					const blocks: string[] = [];
					for (const [uri, diags] of all) {
						blocks.push([`${uriToPath(uri)}:`, ...(diags.length ? formatDiagLines(diags) : ["  no diagnostics"])].join("\n"));
					}
					return finish(blocks.join("\n"));
				},
			},
			{
				name: "lsp_definition",
				description: `Go to definition of the symbol at a position via the TypeScript language server.${positionDescriptionSuffix}`,
				parameters: positionParams(),
				async execute(params, signal) {
					const { filePath } = openTarget("lsp_definition", String(params.path));
					const locations = await current.client.definition(
						filePath,
						Number(params.line),
						Number(params.character),
						signal,
					);
					return finish(locationsText("Definition", locations));
				},
			},
			{
				name: "lsp_references",
				description: `Find all references to the symbol at a position via the TypeScript language server.${positionDescriptionSuffix}`,
				parameters: Type.Object({
					...positionParams().properties,
					includeDeclaration: Type.Optional(
						Type.Boolean({ description: "Include the declaration itself (default false)" }),
					),
				}),
				async execute(params, signal) {
					const { filePath } = openTarget("lsp_references", String(params.path));
					const locations = await current.client.references(
						filePath,
						Number(params.line),
						Number(params.character),
						params.includeDeclaration === true,
						signal,
					);
					return finish(locationsText("References", locations));
				},
			},
			{
				name: "lsp_hover",
				description: `Type/signature hover info for the symbol at a position via the TypeScript language server.${positionDescriptionSuffix}`,
				parameters: positionParams(),
				async execute(params, signal) {
					const { filePath } = openTarget("lsp_hover", String(params.path));
					const text = await current.client.hover(
						filePath,
						Number(params.line),
						Number(params.character),
						signal,
					);
					return finish(text || "No hover information");
				},
			},
		];

		for (const spec of specs) {
			pi.registerTool({
				name: spec.name,
				label: `LSP ${spec.name.replace("lsp_", "")}`,
				description: spec.description,
				parameters: spec.parameters,
				async execute(_toolCallId, params, signal) {
					return spec.execute(params as Record<string, unknown>, signal);
				},
			});
			current.registered.add(spec.name);
		}
	};

	function positionParams() {
		return Type.Object({
			path: Type.String({ description: "File path (absolute or project-relative)" }),
			line: Type.Integer({ description: "1-based line number" }),
			character: Type.Integer({ description: "1-based character offset on the line" }),
		});
	}

	const onCrashed = (current: LspEntry, error?: string): void => {
		registerTools(current, false);
		if (current.notifiedCrash) return;
		current.notifiedCrash = true;
		void pi.sendMessage(
			{
				customType: "hummin-lsp",
				content: `LSP server ${current.config.command} crashed${error ? `: ${error}` : ""}. lsp_* tools are offline; /lsp to restart.`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	};

	const start = async (): Promise<void> => {
		if (runningProcessCount() >= PROCESS_BUDGET) {
			throw new Error(`process budget exhausted (${PROCESS_BUDGET} background jobs)`);
		}
		const current: LspEntry = {
			client: new LspClient("typescript", config, {
				onStateChange: (state, error) => {
					if (state === "crashed" || state === "error") onCrashed(current, error);
				},
			}),
			config,
			registered: new Set(),
			notifiedCrash: false,
		};
		entry = current;
		await current.client.connect();
		registerTools(current, true);
	};

	const restart = async (): Promise<string> => {
		const previous = entry;
		entry = undefined;
		await previous?.client.stop().catch(() => undefined);
		await start();
		return `${config.command}: ready`;
	};

	// /lsp always exists so it can explain how to enable or install.
	pi.registerCommand("lsp", {
		description: "Show language server status and restart it",
		handler: async (_args, ctx) => {
			ctx.ui.notify(statusText(), "info");
			if (!entry || ctx.mode !== "tui") return;
			const action = await ctx.ui.select("LSP", ["Restart", "Close"]);
			if (action !== "Restart") return;
			try {
				ctx.ui.notify(await restart(), "info");
			} catch (error) {
				ctx.ui.notify(`LSP restart failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Diagnostics push: while the server is ready, successful edit/write
	// results on TS/JS files carry the file's fresh diagnostics (bounded).
	const pushDiagnostics = createDiagnosticsPushHandler({ getClient: () => entry?.client, cwd });
	pi.on("tool_result", (event) => pushDiagnostics(event));

	if (!enabled || !isTsProject) return;

	void (async () => {
		if (!(await probeBinary(config.command))) return; // /lsp explains the install
		try {
			await start();
		} catch {
			// client already transitioned to crashed/error; /lsp shows the reason
		}
	})();

	pi.on("session_shutdown", async () => {
		await entry?.client.stop().catch(() => undefined);
	});
}

function formatDiagLines(diags: ReadonlyArray<{ line: number; character: number; severity: number; message: string }>): string[] {
	const names: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
	return diags.map((d) => `${d.line + 1}:${d.character + 1} ${names[d.severity] ?? "info"} ${d.message}`);
}
