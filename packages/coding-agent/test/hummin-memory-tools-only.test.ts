import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, setTelemetryEventSink } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminMemory from "../extensions/hummin-memory.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

// The factory-level fake-ExtensionAPI pattern from hummin-guardrails.test.ts:
// drive the real factory and inspect what it registered, with a throwaway
// agent dir so the machine's own settings and memory store are never touched.
interface RegisteredTool {
	name: string;
	execute: (
		id: string,
		params: { query: string },
		signal: undefined,
		update: undefined,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: object }>;
}

function fakeMemoryPi(): {
	api: ExtensionAPI;
	commands: string[];
	tools: RegisteredTool[];
	handlerNames: () => string[];
	emit: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown>;
} {
	const commands: string[] = [];
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	const emit = async (event: string, payload?: unknown, ctx?: unknown): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	};
	return { api, commands, tools, handlerNames: () => [...handlers.keys()], emit };
}

const dirs: string[] = [];

beforeEach(() => {
	const agentDir = mkdtempSync(join(tmpdir(), "hummin-memory-tools-agent-"));
	const memoryDir = mkdtempSync(join(tmpdir(), "hummin-memory-tools-mem-"));
	const vaultDir = mkdtempSync(join(tmpdir(), "hummin-memory-tools-vault-"));
	dirs.push(agentDir, memoryDir, vaultDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("HUMMIN_MEMORY_DIR", memoryDir);
	vi.stubEnv("HUMMIN_MEMORY_VAULT_DIR", vaultDir);
	// Keep both model-side helpers (expansion, embeddings) off: no endpoints or
	// binaries exist in this environment anyway, and the pins make it hermetic.
	vi.stubEnv("HUMMIN_MEMORY_QUERY_EXPAND", "0");
	vi.stubEnv("HUMMIN_MEMORY_EMBED", "0");
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const PROJ = "/Users/renzof/work/alpha";

function seedLesson(lesson: string): void {
	writeFileSync(join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"), `${JSON.stringify({ cwd: PROJ, lesson })}\n`);
}

describe("humminMemory tools-only mode", () => {
	it("registers the vault tool and dashboard but none of the write paths", () => {
		vi.stubEnv("HUMMIN_MEMORY", "0");
		vi.stubEnv("HUMMIN_MEMORY_TOOLS", "1");
		const { api, commands, tools, handlerNames } = fakeMemoryPi();
		humminMemory(api);
		expect(commands).toEqual(["memory"]);
		expect(tools.map((tool) => tool.name)).toEqual(["vault"]);
		// The recursion bug class lives in the write/shutdown path: tools-only
		// registers no lifecycle handler at all (no recall injection, no
		// session_shutdown distillation, no auto-fold, no held-job sweep).
		expect(handlerNames()).toEqual([]);
	});

	it("registers nothing beyond the dashboard without HUMMIN_MEMORY_TOOLS=1", () => {
		vi.stubEnv("HUMMIN_MEMORY", "0");
		const { api, commands, tools, handlerNames } = fakeMemoryPi();
		humminMemory(api);
		expect(commands).toEqual(["memory"]);
		expect(tools).toEqual([]);
		expect(handlerNames()).toEqual([]);
	});

	it("full memory mode still registers the write paths", () => {
		vi.stubEnv("HUMMIN_MEMORY", "1");
		const { api, tools, handlerNames } = fakeMemoryPi();
		humminMemory(api);
		expect(tools.map((tool) => tool.name)).toContain("vault");
		expect(handlerNames()).toContain("before_agent_start");
		expect(handlerNames()).toContain("session_shutdown");
		expect(handlerNames()).toContain("session_start");
	});

	it("the tools-only vault tool searches the seeded lesson store", async () => {
		vi.stubEnv("HUMMIN_MEMORY", "0");
		vi.stubEnv("HUMMIN_MEMORY_TOOLS", "1");
		seedLesson("Gotcha: docker compose needs --force-recreate after mem_limit changes");
		const { api, tools } = fakeMemoryPi();
		humminMemory(api);
		const vault = tools.find((tool) => tool.name === "vault");
		expect(vault).toBeDefined();
		const result = await vault!.execute("id", { query: "docker compose quotas" }, undefined, undefined, {
			cwd: PROJ,
		});
		expect(result.content[0].text).toContain("Gotcha: docker compose needs --force-recreate");
	});

	it("emits the telemetry contract events for injection and vault search", async () => {
		const events: { name: string; attributes?: Record<string, unknown> }[] = [];
		setTelemetryEventSink({
			write: (record) =>
				events.push({ name: record.name, attributes: record.attributes as Record<string, unknown> }),
		});
		try {
			vi.stubEnv("HUMMIN_MEMORY", "1");
			seedLesson("Gotcha: docker compose needs --force-recreate after mem_limit changes");
			const { api, tools, emit } = fakeMemoryPi();
			humminMemory(api);
			// Auto-briefing injection via the recall handler.
			const ctx = {
				cwd: PROJ,
				sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
			};
			await emit("before_agent_start", { prompt: "docker compose quotas" }, ctx);
			const injected = events.find((event) => event.name === "memory_lessons_injected");
			expect(injected?.attributes?.count).toBe(1);
			expect(injected?.attributes?.ids).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/)]);
			// Vault tool search.
			const vault = tools.find((tool) => tool.name === "vault");
			await vault!.execute("id", { query: "docker compose quotas" }, undefined, undefined, { cwd: PROJ });
			expect(events.some((event) => event.name === "vault_searched" && event.attributes?.results === 1)).toBe(true);
		} finally {
			setTelemetryEventSink(undefined);
		}
	});
});
