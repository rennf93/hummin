/** Project bootstrap and diagnostics commands. */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeFleet, serversFor } from "./hummin-fleet.ts";

const execFileAsync = promisify(execFile);

function projectSummary(ctx: ExtensionContext): string {
	const entries = readdirSync(ctx.cwd, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
	const packagePath = join(ctx.cwd, "package.json");
	const packageText = existsSync(packagePath) ? readFileSync(packagePath, "utf8").slice(0, 8000) : "(no package.json)";
	const readme = ["README.md", "README", "readme.md"].find((name) => existsSync(join(ctx.cwd, name)));
	const readmeText = readme ? readFileSync(join(ctx.cwd, readme), "utf8").slice(0, 8000) : "(no README)";
	const agents = existsSync(join(ctx.cwd, "AGENTS.md"))
		? readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8").slice(0, 12000)
		: "(none)";
	return `Repository: ${ctx.cwd}\nTop-level entries: ${entries.map((entry) => entry.name).join(", ")}\nExisting AGENTS.md:\n${agents}\npackage.json:\n${packageText}\nREADME:\n${readmeText}`;
}

async function chooseCloudModel(ctx: ExtensionContext) {
	const fleetHosts = new Set(SettingsManager.create(ctx.cwd).getFleetServers().map((server) => server.hostIp));
	const isCloud = (model: Model<Api>): boolean => {
		if (/hummin|llamacpp|ollama|local/i.test(model.provider)) return false;
		try {
			const url = new URL(model.baseUrl);
			const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
			if (url.protocol !== "https:" || fleetHosts.has(host)) return false;
			if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) return false;
			if (/^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
			if (host.includes(":")) return false;
			return ctx.modelRegistry.getProviderAuthStatus(model.provider).configured;
		} catch {
			return false;
		}
	};
	if (ctx.model && isCloud(ctx.model)) return ctx.model;
	const models = ctx.modelRegistry.getAvailable().filter(isCloud);
	if (models.length === 0) return undefined;
	const choice = await ctx.ui.select(
		"Choose a cloud model for /init",
		models.map((model) => `${model.provider}/${model.id}`),
	);
	return choice ? models.find((model) => `${model.provider}/${model.id}` === choice) : undefined;
}

async function initProject(ctx: ExtensionContext): Promise<void> {
	const path = join(ctx.cwd, "AGENTS.md");
	const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	if (original !== undefined && !(await ctx.ui.confirm("AGENTS.md exists", "Generate a replacement?"))) return;
	const model = await chooseCloudModel(ctx);
	if (!model) {
		ctx.ui.notify("No cloud model selected", "warning");
		return;
	}
	const prompt = `Generate a concise, practical AGENTS.md for this repository. Include commands, code conventions, testing rules, and architecture facts supported by the supplied files. Return only Markdown.\n\n${projectSummary(ctx)}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 120000);
	let response;
	try {
		response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			} satisfies Context,
			{ signal: controller.signal },
		);
	} catch {
		clearTimeout(timeout);
		ctx.ui.notify("AGENTS.md generation failed", "error");
		return;
	}
	clearTimeout(timeout);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		ctx.ui.notify("AGENTS.md generation failed", "error");
		return;
	}
	const draft = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
	if (!draft) {
		ctx.ui.notify("Model returned an empty AGENTS.md", "error");
		return;
	}
	const reviewed = await ctx.ui.editor("Review generated AGENTS.md", draft);
	if (reviewed === undefined || !reviewed.trim()) return;
	if (
		(original === undefined && existsSync(path)) ||
		(original !== undefined && (!existsSync(path) || readFileSync(path, "utf8") !== original))
	) {
		ctx.ui.notify("AGENTS.md changed while generating; refusing to overwrite", "warning");
		return;
	}
	writeFileSync(path, reviewed.endsWith("\n") ? reviewed : `${reviewed}\n`, {
		encoding: "utf8",
		flag: original === undefined ? "wx" : "w",
	});
	ctx.ui.notify(`wrote ${path}`, "info");
}

/** HUMMIN_* env vars that silently beat settings.json, plus the laya
 * credential (presence only). Names verified against settings-manager.ts and
 * the hummin extensions; /doctor surfaces them so "why is my setting ignored"
 * has an answer. Pre-rename fallbacks (HUMMIN_COLIBRI_INSTANCES,
 * HUMMIN_COLIBRI_CTX) are deliberately not listed. */
interface EnvOverride {
	name: string;
	overrides: string;
	/** Credential-like: /doctor shows "(set)", never the value. */
	secret?: boolean;
}

const ENV_OVERRIDES: EnvOverride[] = [
	{ name: "HUMMIN_INSTANCES", overrides: "ordered fleet servers" },
	{ name: "HUMMIN_CTX", overrides: "per-model context window fallback" },
	{ name: "HUMMIN_MEMORY_DIR", overrides: "memory storage dir" },
	{ name: "HUMMIN_MEMORY_VAULT_DIR", overrides: "memory vault dir" },
	{ name: "HUMMIN_MEMORY_PROVIDER", overrides: "memory provider" },
	{ name: "HUMMIN_MEMORY_MODEL_ID", overrides: "memory model id" },
	{ name: "HUMMIN_LAYA_URL", overrides: "laya service URL" },
	{ name: "HUMMIN_LAYA_GATE", overrides: "laya bash tripwire switch" },
	{ name: "HUMMIN_LAYA_STEER", overrides: "laya per-turn steering switch" },
	{ name: "HUMMIN_LAYA_GATE_THRESHOLD", overrides: "laya gate block threshold (settings layaGateThreshold)" },
	{ name: "HUMMIN_LAYA_STEER_THRESHOLD", overrides: "laya steer threshold (settings layaSteerThreshold)" },
	{ name: "HUMMIN_LAYA_TRIAGE", overrides: "laya test-failure triage switch" },
	{ name: "HUMMIN_LAYA_INTAKE", overrides: "laya lesson-intake gate switch" },
	{ name: "COLI_API_KEY", overrides: "laya credential", secret: true },
];

/** Pure /doctor section builder: the header plus one line per set override,
 * or a "none" line when nothing overrides, so users learn the section exists.
 * Takes an env record instead of process.env so tests can cover set, unset,
 * and presence-only cases. */
export function environmentOverridesSection(env: Record<string, string | undefined>): string[] {
	const lines: string[] = [];
	for (const { name, overrides, secret } of ENV_OVERRIDES) {
		const value = env[name]?.trim();
		if (!value) continue;
		lines.push(`  ${name}: ${secret ? "(set)" : value} (${overrides})`);
	}
	return ["environment overrides:", ...(lines.length > 0 ? lines : ["  none"])];
}

async function doctor(ctx: ExtensionContext): Promise<void> {
	const settings = SettingsManager.create(ctx.cwd);
	const servers = serversFor(ctx);
	const health = await probeFleet(servers, ctx);
	let vaultGit = "not a git repository";
	const vault = settings.getMemoryVaultDir();
	try {
		if (!existsSync(join(vault, ".git"))) throw new Error("missing .git");
		const options = { timeout: 5000, env: { ...process.env, HUMMIN_MEMORY: "0" } };
		await execFileAsync("git", ["-C", vault, "rev-parse", "--is-inside-work-tree"], options);
		const result = await execFileAsync("git", ["-C", vault, "status", "--porcelain"], options);
		vaultGit = result.stdout.trim() ? "dirty" : "clean";
	} catch {
		/* vault may not be initialized */
	}
	const auth = ctx.modelRegistry.getProviderAuthStatus("zai");
	const fleetLines = servers.length
		? servers.map((server) => `${server.id}: ${health.get(server.id) ? "running" : "stopped or unreachable"}`)
		: [];
	const extensionCount = ctx.getExtensionPaths?.().length;
	ctx.ui.notify(
			[
				`settings parse: ${settings.drainErrors().length === 0 ? "OK" : "ERROR"}`,
				...environmentOverridesSection(process.env),
				`fleet: ${servers.length ? `${servers.length} configured` : "not configured"}`,
			`zai credential: ${auth.configured ? "present" : "missing"}`,
			`extensions loaded: ${extensionCount === undefined ? "unknown" : extensionCount}`,
			`vault git: ${vaultGit}`,
			...fleetLines,
		].join("\n"),
		"info",
	);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("init", {
		description: "Generate a project AGENTS.md",
		category: "Session",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/init requires interactive review", "warning");
				return;
			}
			try {
				await initProject(ctx);
			} catch (error) {
				ctx.ui.notify(`/init failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
	pi.registerCommand("doctor", {
		description: "Check hummin settings, fleet, credentials, extensions, and vault",
		category: "Settings",
		handler: async (_args, ctx) => {
			try {
				await doctor(ctx);
			} catch (error) {
				ctx.ui.notify(`/doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
