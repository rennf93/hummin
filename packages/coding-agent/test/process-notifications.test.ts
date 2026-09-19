import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import subagentExtension from "../extensions/hummin-subagents.ts";
import { ProcessManager } from "../extensions/lib/processes.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
const directories: string[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function newDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

/** Drain delay in ProcessManager: post-exit pipes get 1000ms before destroy. */
const DRAIN_MS = 1400;

it("emits exactly one completion callback when exit and drain-timer both reach finish", async () => {
	const dir = newDirectory("process-notifications-");
	const manager = new ProcessManager(join(dir, "subagents"), "task");
	cleanups.push(() => manager.close());
	const onComplete = vi.fn();
	const job = manager.start({
		command: process.execPath,
		args: ["-e", "process.stdout.write('done')"],
		cwd: dir,
		kind: "task",
		label: "instant exit",
		timeoutMs: 30_000,
		onComplete,
	});
	await job.done;
	// Let the post-exit drain timer fire and race the already-run close path.
	await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
	expect(onComplete).toHaveBeenCalledTimes(1);
	expect(onComplete.mock.calls[0][0].id).toBe(job.id);
	expect(job.state).toBe("completed");
});

it("emits exactly one completion callback for a cancelled job, once terminal", async () => {
	const dir = newDirectory("process-notifications-");
	const manager = new ProcessManager(join(dir, "subagents"), "task");
	cleanups.push(() => manager.close());
	const script = join(dir, "wait.mjs");
	writeFileSync(script, "setInterval(() => {}, 100);");
	const onComplete = vi.fn();
	const job = manager.start({
		command: process.execPath,
		args: [script],
		cwd: dir,
		kind: "task",
		label: "cancelled job",
		timeoutMs: 60_000,
		onComplete,
	});
	job.stop();
	await job.done;
	await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
	expect(onComplete).toHaveBeenCalledTimes(1);
	expect(job.state).toBe("cancelled");
});

it("delivers a background completion once, via followUp only (no duplicate notify)", async () => {
	const dir = newDirectory("hummin-notifications-");
	vi.stubEnv(ENV_AGENT_DIR, dir);
	const tools = new Map<string, ToolDefinition>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	subagentExtension({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendMessage,
		on: () => {},
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: dir,
		ui: { notify, setStatus: () => {} },
		modelRegistry: { getAvailable: () => [{ provider: "fleet-host", id: "Org/Model" }] },
	} as unknown as ExtensionContext;
	const binary = join(dir, "hummin");
	writeFileSync(binary, `#!${process.execPath}\nconsole.log("child output");\n`);
	chmodSync(binary, 0o755);
	vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
	await tools
		.get("task")!
		.execute("child", { prompt: "test", model: "fleet-host/Org/Model", background: true }, undefined, undefined, ctx);
	await expect.poll(() => sendMessage.mock.calls.length).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
	// Replay window elapsed: still exactly one delivery, and no redundant
	// notify duplicating the same summary the followUp renders.
	expect(sendMessage.mock.calls.length).toBe(1);
	expect(sendMessage.mock.calls[0][1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
	expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("child output"), expect.anything());
});

it("background task survives turn-signal abort (signal not forwarded)", async () => {
	const dir = newDirectory("hummin-detached-");
	vi.stubEnv(ENV_AGENT_DIR, dir);
	const tools = new Map<string, ToolDefinition>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	subagentExtension({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendMessage,
		on: () => {},
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: dir,
		ui: { notify, setStatus: () => {} },
		modelRegistry: { getAvailable: () => [{ provider: "fleet-host", id: "Org/Model" }] },
	} as unknown as ExtensionContext;
	const binary = join(dir, "hummin");
	// Child runs long enough for the abort to land mid-run.
	writeFileSync(binary, `#!${process.execPath}\nsetTimeout(() => { console.log("child output"); }, 300);\n`);
	chmodSync(binary, 0o755);
	vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
	const controller = new AbortController();
	const execution = tools
		.get("task")!
		.execute(
			"child",
			{ prompt: "test", model: "fleet-host/Org/Model", background: true },
			controller.signal,
			undefined,
			ctx,
		);
	setTimeout(() => controller.abort(), 50);
	await expect.poll(() => sendMessage.mock.calls.length, { timeout: 5000 }).toBe(1);
	// The followUp must report completion, not cancellation: interrupting the
	// agent must not cancel background work.
	expect(String(sendMessage.mock.calls[0][0].content)).toContain("completed");
	await execution;
});
