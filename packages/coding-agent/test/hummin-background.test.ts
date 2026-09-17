import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import monitorExtension from "../extensions/hummin-monitor.ts";
import planExtension from "../extensions/hummin-plan.ts";
import subagentExtension from "../extensions/hummin-subagents.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
const directories: string[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function load(extension: (pi: ExtensionAPI) => void) {
	const cwd = mkdtempSync(join(tmpdir(), "hummin-background-"));
	directories.push(cwd);
	vi.stubEnv(ENV_AGENT_DIR, cwd);
	const tools = new Map<string, ToolDefinition>();
	const sendMessage = vi.fn();
	let shutdown = async () => {};
	extension({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendMessage,
		on: (name: string, handler: () => Promise<void>) => {
			if (name === "session_shutdown") shutdown = handler;
		},
	} as unknown as ExtensionAPI);
	cleanups.push(() => shutdown());
	const ctx = {
		cwd,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		modelRegistry: { getAvailable: () => [{ provider: "fleet-host", id: "Org/Model" }] },
	} as unknown as ExtensionContext;
	return { cwd, tools, sendMessage, ctx, shutdown: () => shutdown() };
}

it("delivers a monitor's filtered final output and completion without polling", async () => {
	const { tools, ctx, sendMessage } = load(monitorExtension);
	const result = await tools
		.get("monitor")!
		.execute(
			"watch",
			{ action: "start", command: "printf 'info ignored\nERROR found\n'", match: "ERROR" },
			undefined,
			undefined,
			ctx,
		);
	expect(result.details).toHaveProperty("monitorId");
	await expect.poll(() => sendMessage.mock.calls.length).toBe(2);
	expect(sendMessage.mock.calls[0][0].content).toContain("ERROR found");
	expect(sendMessage.mock.calls[0][0].content).not.toContain("info ignored");
	expect(sendMessage.mock.calls[1][0].content).toContain("completed");
});

it("routes an actual child tool invocation and delivers its captured completion", async () => {
	const { cwd, tools, ctx, sendMessage } = load(subagentExtension);
	const binary = join(cwd, "hummin");
	writeFileSync(
		binary,
		`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),memory:process.env.HUMMIN_MEMORY}));\n`,
	);
	chmodSync(binary, 0o755);
	vi.stubEnv("PATH", `${cwd}:${process.env.PATH}`);
	const result = await tools
		.get("task")!
		.execute("child", { prompt: "test", model: "fleet-host/Org/Model", background: true }, undefined, undefined, ctx);
	expect(result.details).toHaveProperty("taskId");
	await expect.poll(() => sendMessage.mock.calls.length).toBe(1);
	const content = sendMessage.mock.calls[0][0].content;
	expect(content).toContain('"--provider","fleet-host","--model","Org/Model"');
	expect(content).toContain('"memory":"0"');
});

it("does not send completion messages into a replacement session after shutdown", async () => {
	const { cwd, tools, ctx, sendMessage, shutdown } = load(monitorExtension);
	const script = join(cwd, "wait.mjs");
	writeFileSync(script, "setInterval(() => {}, 100);");
	await tools
		.get("monitor")!
		.execute(
			"watch",
			{ action: "start", command: `exec '${process.execPath}' '${script}'` },
			undefined,
			undefined,
			ctx,
		);
	await shutdown();
	expect(sendMessage).not.toHaveBeenCalled();
});

it("blocks background launches in plan mode while allowing monitor inspection and cancellation", async () => {
	let check: ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) | undefined;
	let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	planExtension({
		on: (name: string, handler: unknown) => {
			if (name === "tool_call") check = handler as typeof check;
			if (name === "session_start") start = handler as typeof start;
		},
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI);
	await start!(null, {
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "hummin-plan-mode", data: { enabled: true } }],
		},
	});
	expect(await check!({ toolName: "task", input: {} })).toMatchObject({ block: true });
	expect(await check!({ toolName: "monitor", input: { action: "start" } })).toMatchObject({ block: true });
	expect(await check!({ toolName: "monitor", input: { action: "stop" } })).toBeUndefined();
	expect(await check!({ toolName: "monitor", input: { action: "status" } })).toBeUndefined();
});
