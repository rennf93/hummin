/**
 * Fork contract index: every code-checkable hummin fork rule and the test that
 * enforces it. Check this table after each upstream merge. "here" means a
 * test in this file; other entries are paths under packages/coding-agent/ (or
 * the repo root for scripts/).
 *
 * | Rule                                                      | Enforced by |
 * | --------------------------------------------------------- | ----------- |
 * | Fleet order defines preference / tie-break                | test/hummin-fleet-model-resolution.test.ts ("--model <exact id> picks the first fleet server", "hummin-local registration ... keeps fleet order, not port order") |
 * | Providers per engine+host+port (see CONTRADICTION below) | test/hummin-local-extension.test.ts ("uses the configured context fallback and preserves host and port identity") |
 * | HUMMIN_INSTANCES overrides fleet.servers                  | here ("HUMMIN_INSTANCES beats settings fleet.servers") |
 * | HUMMIN_COLIBRI_INSTANCES pre-rename fallback              | here ("HUMMIN_COLIBRI_INSTANCES is the fallback ...") |
 * | settings key colibriInstances fallback                    | here ("settings colibriInstances is the fallback for localInstances") |
 * | Offline catalog only from configured server models        | test/hummin-local-extension.test.ts ("does not invent offline models ...", "labels explicit fleet catalog models as offline") |
 * | Context window: /props, then HUMMIN_CTX, legacy CTX       | here ("context window comes from /props first, then HUMMIN_CTX, then HUMMIN_COLIBRI_CTX") |
 * | qwen-family models carry thinkingFormat qwen-chat-template| here ("qwen-family models carry ...") |
 * | Spawned children set HUMMIN_MEMORY=0 (ProcessManager)     | here ("ProcessManager forces HUMMIN_MEMORY=0 ...") ; test/hummin-processes.test.ts |
 * | Spawned children set HUMMIN_MEMORY=0 (cron child env)     | here ("cron child command supplies HUMMIN_MEMORY=0") |
 * | Spawned children set HUMMIN_MEMORY=0 (all other spawners) | here ("every spawn call site in extensions/ sets HUMMIN_MEMORY=0 ...", per call site, explicit exception list) |
 * | Memory/vault tests use temp dirs                          | here ("memory extension tests pin ...") |
 * | HUMMIN_MEMORY_VAULT_DIR beats settings memoryVaultDir     | here ("HUMMIN_MEMORY_VAULT_DIR beats the memoryVaultDir setting") |
 * | http-dispatcher uses EnvHttpProxyAgent                    | test/http-dispatcher.test.ts ("tunnels proxied HTTP origins") |
 * | Default idle timeout not shortened; 0 allowed             | here ("default http idle timeout is not shortened ...") ; test/config-schemas.test.ts (httpIdleTimeoutMs: 0 accepted) |
 * | Process title is hummin                                   | here ("process title derives from DISPLAY_NAME ...", formatting-tolerant source patterns) |
 * | Extensions autoload from <agentDir>/extensions            | here ("every bundled extension file is seeded ...") |
 * | @earendil-works/* package names stay                      | here ("workspace package names keep the upstream scope") |
 * | Fork identity constants                                   | test/fork-identity-guard.test.ts |
 * | remoteCatalog: false                                      | test/remote-catalog-provider.test.ts ("skips the default pi.dev catalog ... (fork remoteCatalog: false)") ; here (config flag) |
 * | release.mjs catalog pin opt-in                            | scripts/release-fork-contract.test.mjs |
 * | Exact upstream pin (UPSTREAM_VERSION)                     | scripts/stage-fork-contract.test.mjs |
 *
 * Not code-checkable (process or docs): thin overlay / zero deletions, no rename
 * sweeps, private docs outside the repo, never kill by process name, verify
 * absence claims, inspect git diff before attributing changes, parallel child
 * file ownership, vault inspected through the vault tool, private fleet data
 * kept in private settings, "do not fix hangs by shortening timeouts" (only the
 * default value is pinned here).
 *
 * CONTRADICTION: AGENTS.md says "The local provider id is hummin". The code
 * registers one provider per engine+host+port (id "llamacpp-<host>-<port>");
 * the string "hummin" is only the default API key. interactive-mode.ts and
 * model-selector.ts test provider ids with startsWith("hummin"), which never
 * matches those ids. Neither side is encoded as a test.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminLocalExtension from "../extensions/hummin-local.ts";
import { childCommand } from "../extensions/lib/cron-store.ts";
import { ProcessManager } from "../extensions/lib/processes.ts";
import { DISPLAY_NAME, ENV_AGENT_DIR, getBundledExtensionsDir, REMOTE_CATALOG_ENABLED } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { seedBundledExtensions } from "../src/migrations.ts";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, openAICompletionsApi: () => ({ stream: vi.fn(), streamSimple: vi.fn() }) };
});

const PACKAGE_DIR = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "../..");

interface RegisteredProvider {
	id: string;
	getModels(): readonly { id: string; contextWindow: number; compat?: { thinkingFormat?: string } }[];
}

function fakeApi(providers: RegisteredProvider[]): ExtensionAPI {
	return {
		registerProvider: (provider: RegisteredProvider) => providers.push(provider),
		on: () => () => {},
	} as unknown as ExtensionAPI;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Serve /v1/models with the given ids and /props with an optional n_ctx. */
function stubFleet(modelIds: string[], nCtx?: number): void {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: string | URL): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/v1/models")) return Promise.resolve(json({ data: modelIds.map((id) => ({ id })) }));
			if (url.endsWith("/props") && nCtx)
				return Promise.resolve(json({ default_generation_settings: { n_ctx: nCtx } }));
			return Promise.resolve(json({}, 404));
		}),
	);
}

async function discover(): Promise<RegisteredProvider[]> {
	const providers: RegisteredProvider[] = [];
	await humminLocalExtension(fakeApi(providers));
	return providers;
}

function mockFleetSettings(ports: number[], memoryVaultDir?: string): void {
	vi.spyOn(SettingsManager, "create").mockReturnValue({
		getFleetServers: () =>
			ports.map((port) => ({ id: `s${port}`, hostIp: "127.0.0.1", port, kind: "docker", target: `s${port}` })),
		getLocalInstances: () => [],
		memoryVaultDir,
	} as unknown as SettingsManager);
}

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	// Nothing here may read the developer's real agent dir, settings or env.
	vi.stubEnv(ENV_AGENT_DIR, tempDir("hummin-contract-agent-"));
	vi.stubEnv("HUMMIN_FLEET_HEALTH_FILE", join(tempDir("hummin-contract-"), "fleet-health.json"));
	for (const name of [
		"HUMMIN_INSTANCES",
		"HUMMIN_COLIBRI_INSTANCES",
		"HUMMIN_CTX",
		"HUMMIN_COLIBRI_CTX",
		"HUMMIN_MEMORY_VAULT_DIR",
	]) {
		vi.stubEnv(name, undefined);
	}
	mockFleetSettings([]);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hummin-local fleet env contract", () => {
	it("HUMMIN_INSTANCES beats settings fleet.servers", async () => {
		mockFleetSettings([29101]);
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:29102");
		stubFleet(["m"]);

		expect((await discover()).map((p) => p.id)).toEqual(["llamacpp-127.0.0.1-29102"]);
	});

	it("settings fleet.servers is used when no env override is set", async () => {
		mockFleetSettings([29103]);
		vi.stubEnv("HUMMIN_INSTANCES", undefined);
		vi.stubEnv("HUMMIN_COLIBRI_INSTANCES", undefined);
		stubFleet(["m"]);

		expect((await discover()).map((p) => p.id)).toEqual(["llamacpp-127.0.0.1-29103"]);
	});

	it("HUMMIN_COLIBRI_INSTANCES is the fallback when HUMMIN_INSTANCES is unset", async () => {
		mockFleetSettings([29104]);
		vi.stubEnv("HUMMIN_INSTANCES", undefined);
		vi.stubEnv("HUMMIN_COLIBRI_INSTANCES", "http://127.0.0.1:29105");
		stubFleet(["m"]);

		expect((await discover()).map((p) => p.id)).toEqual(["llamacpp-127.0.0.1-29105"]);
	});

	it("settings colibriInstances is the fallback for localInstances", () => {
		vi.stubEnv("HUMMIN_INSTANCES", undefined);
		vi.stubEnv("HUMMIN_COLIBRI_INSTANCES", undefined);
		const settings = SettingsManager.inMemory({ colibriInstances: ["http://127.0.0.1:29108"] });
		expect(settings.getLocalInstances()).toEqual(["http://127.0.0.1:29108"]);
	});

	it("context window comes from /props first, then HUMMIN_CTX, then HUMMIN_COLIBRI_CTX", async () => {
		// Distinct ports per phase: discovery results are cached per fleet config.
		vi.stubEnv("HUMMIN_CTX", "111111");
		vi.stubEnv("HUMMIN_COLIBRI_CTX", "222222");

		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:29106");
		stubFleet(["m"], 333333);
		expect((await discover())[0]?.getModels()[0]?.contextWindow).toBe(333333);

		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:29109");
		stubFleet(["m"]);
		expect((await discover())[0]?.getModels()[0]?.contextWindow).toBe(111111);

		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:29110");
		vi.stubEnv("HUMMIN_CTX", undefined);
		expect((await discover())[0]?.getModels()[0]?.contextWindow).toBe(222222);
	});

	it("qwen-family models carry thinkingFormat qwen-chat-template, other families do not", async () => {
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:29107");
		stubFleet(["qwen3.8-coder", "glm-5.3"]);

		const models = (await discover())[0]?.getModels() ?? [];

		expect(models.find((m) => m.id === "qwen3.8-coder")?.compat?.thinkingFormat).toBe("qwen-chat-template");
		expect(models.find((m) => m.id === "glm-5.3")?.compat?.thinkingFormat).toBeUndefined();
	});
});

/** Source text of the call whose opening paren is at openIndex (paren depth only). */
function callText(source: string, openIndex: number): string {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		if (source[i] === "(") depth++;
		else if (source[i] === ")" && --depth === 0) return source.slice(openIndex, i + 1);
	}
	return source.slice(openIndex);
}

describe("memory contract", () => {
	// A spawned hummin child with the memory extension enabled would run its own
	// shutdown handler and spawn again, without bound.
	it("ProcessManager forces HUMMIN_MEMORY=0 even when the caller passes another value", async () => {
		vi.stubEnv("HUMMIN_MEMORY", "1");
		const dir = tempDir("hummin-contract-proc-");
		const manager = new ProcessManager(join(dir, "logs"), "task");
		try {
			const job = manager.start({
				command: process.execPath,
				args: ["-e", "console.log('mem=' + process.env.HUMMIN_MEMORY)"],
				cwd: dir,
				kind: "task",
				label: "contract",
				timeoutMs: 10_000,
				env: { HUMMIN_MEMORY: "1" },
			});
			await job.done;
			expect(job.output).toContain("mem=0");
		} finally {
			await manager.close();
		}
	});

	it("cron child command supplies HUMMIN_MEMORY=0", () => {
		expect(childCommand({ prompt: "p", cwd: "/tmp" }).env).toEqual({ HUMMIN_MEMORY: "0" });
	});

	// Spawners with no callable seam are checked per call site in the source.
	// Exceptions, each deliberate: hummin-cron.ts takes env from childCommand
	// (tested above); hummin-tg-hub.ts starts the telegram broker, not a session.
	it("every spawn call site in extensions/ sets HUMMIN_MEMORY=0 except the listed exceptions", () => {
		const extensionsDir = join(PACKAGE_DIR, "extensions");
		const files = readdirSync(extensionsDir, { recursive: true })
			.map(String)
			.filter((name) => name.endsWith(".ts"));
		expect(files).toContain("hummin-memory.ts");
		const violators = new Set<string>();
		for (const file of files) {
			const source = readFileSync(join(extensionsDir, file), "utf8");
			for (const match of source.matchAll(/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync)\(/g)) {
				const lineStart = source.lastIndexOf("\n", match.index) + 1;
				if (/^\s*(?:\*|\/\/|\/\*)/.test(source.slice(lineStart, match.index))) continue;
				const call = callText(source, match.index + match[0].length - 1);
				if (/^\(\s*"git"/.test(call)) continue;
				if (!/HUMMIN_MEMORY:\s*["']0["']/.test(call)) violators.add(file);
			}
		}
		expect([...violators].sort()).toEqual(["hummin-cron.ts", "hummin-tg-hub.ts"]);
	});

	it("memory extension tests pin HUMMIN_MEMORY_VAULT_DIR (and HUMMIN_MEMORY_DIR unless vault-only) to temp dirs", () => {
		// Vault-only entry points: they never touch the memory store dir.
		const vaultOnly = new Set(["hummin-memory-canvas.test.ts", "hummin-memory-dashboard.test.ts"]);
		const testDir = join(PACKAGE_DIR, "test");
		const checked: string[] = [];
		for (const name of readdirSync(testDir)) {
			if (!name.endsWith(".test.ts") || name === "hummin-fork-contract.test.ts") continue;
			const source = readFileSync(join(testDir, name), "utf8");
			if (!/from "\.\.\/extensions\/(?:hummin-memory|lib\/memory-workers)\.ts"/.test(source)) continue;
			checked.push(name);
			expect(source, name).toContain("HUMMIN_MEMORY_VAULT_DIR");
			if (!vaultOnly.has(name)) expect(source, name).toContain("HUMMIN_MEMORY_DIR");
		}
		expect(checked).toContain("hummin-memory-fold.test.ts");
	});

	it("HUMMIN_MEMORY_VAULT_DIR beats the memoryVaultDir setting", () => {
		const settings = SettingsManager.inMemory({ memoryVaultDir: "/from/settings" });
		vi.stubEnv("HUMMIN_MEMORY_VAULT_DIR", "/from/env");
		expect(settings.getMemoryVaultDir()).toBe("/from/env");
		vi.stubEnv("HUMMIN_MEMORY_VAULT_DIR", undefined);
		expect(settings.getMemoryVaultDir()).toBe("/from/settings");
	});
});

describe("runtime identity contract", () => {
	it("default http idle timeout is not shortened below 300000ms", () => {
		expect(DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
	});

	it("process title derives from DISPLAY_NAME, which is hummin", () => {
		expect(DISPLAY_NAME).toBe("hummin");
		expect(readFileSync(join(PACKAGE_DIR, "src/cli/setup.ts"), "utf8")).toMatch(
			/process\.title\s*=\s*DISPLAY_NAME\b/,
		);
		expect(readFileSync(join(PACKAGE_DIR, "src/rpc-entry.ts"), "utf8")).toMatch(
			/process\.title\s*=\s*`\$\{DISPLAY_NAME\}-rpc`/,
		);
	});

	it("every bundled extension file is seeded into <agentDir>/extensions", () => {
		const agentDir = tempDir("hummin-contract-seed-");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		seedBundledExtensions();
		const bundled = readdirSync(getBundledExtensionsDir(), { recursive: true })
			.map(String)
			.filter((name) => name.endsWith(".ts"));
		expect(bundled).toContain("hummin-local.ts");
		for (const name of bundled) expect(existsSync(join(agentDir, "extensions", name)), name).toBe(true);
	});

	it("workspace package names keep the upstream scope", () => {
		for (const dir of readdirSync(join(REPO_ROOT, "packages"))) {
			const manifest = join(REPO_ROOT, "packages", dir, "package.json");
			if (!existsSync(manifest)) continue;
			const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string };
			expect(name, dir).toMatch(/^@earendil-works\//);
		}
	});

	it("remote model catalog is disabled in the fork package config", () => {
		expect(REMOTE_CATALOG_ENABLED).toBe(false);
	});
});
