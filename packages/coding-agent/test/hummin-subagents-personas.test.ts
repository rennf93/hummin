import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import subagentExtension, {
	composePersonaPrompt,
	interpolatePrevious,
	PERSONA_NAME_RE,
	resolvePersonaBody,
} from "../extensions/hummin-subagents.ts";
import { ProcessManager } from "../extensions/lib/processes.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/index.ts";

// Personas and chaining for the task tool: pure composer/interpolator tests,
// persona file resolution, and the after_task_id wiring at the execute seam.

const cleanups: string[] = [];
afterEach(async () => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

function loadTaskTool(cwd: string): ToolDefinition {
	vi.stubEnv(ENV_AGENT_DIR, cwd);
	const tools = new Map<string, ToolDefinition>();
	subagentExtension({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI);
	return tools.get("task")!;
}

function chainCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		ui: {},
		modelRegistry: {
			getAvailable: () => [
				{ provider: "fleet-host", id: "Org/Model", reasoning: true, thinkingLevelMap: { high: "high" } },
			],
		},
	} as unknown as ExtensionContext;
}

it("interpolates {previous} everywhere it occurs", () => {
	expect(interpolatePrevious("Review {previous} then fix {previous}", "REPORT")).toBe("Review REPORT then fix REPORT");
	expect(interpolatePrevious("no placeholder", "REPORT")).toBe("no placeholder");
});

it("composes the persona block and no-ops on an empty body", () => {
	const composed = composePersonaPrompt("reviewer", "Be terse. Cite file:line.", "Fix the bug");
	expect(composed).toContain('persona "reviewer"');
	expect(composed).toContain("Be terse. Cite file:line.");
	expect(composed.endsWith("---\n\nFix the bug")).toBe(true);
	expect(composePersonaPrompt("reviewer", "   \n  ", "Fix the bug")).toBe("Fix the bug");
});

it("persona names exclude path separators and dots", () => {
	expect(PERSONA_NAME_RE.test("reviewer-2")).toBe(true);
	expect(PERSONA_NAME_RE.test("../etc/passwd")).toBe(false);
	expect(PERSONA_NAME_RE.test(".hidden")).toBe(false);
	expect(PERSONA_NAME_RE.test("a".repeat(65))).toBe(false);
});

it("resolves personas project-first, then global, and errors with the search paths", () => {
	const agentDir = tempDir("hummin-personas-agent-");
	const cwd = tempDir("hummin-personas-project-");
	mkdirSync(join(cwd, CONFIG_DIR_NAME, "agents"), { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "agents", "reviewer.md"), "project body\n");
	writeFileSync(join(agentDir, "agents", "reviewer.md"), "global body\n");
	writeFileSync(join(agentDir, "agents", "only-global.md"), "global body\n");

	expect(resolvePersonaBody("reviewer", { projectTrusted: true, cwd, agentDir })).toBe("project body");
	expect(resolvePersonaBody("reviewer", { projectTrusted: false, cwd, agentDir })).toBe("global body");
	expect(resolvePersonaBody("only-global", { projectTrusted: true, cwd, agentDir })).toBe("global body");
	expect(() => resolvePersonaBody("missing", { projectTrusted: true, cwd, agentDir })).toThrow(
		/Unknown persona: missing/,
	);
	expect(() => resolvePersonaBody("../escape", { projectTrusted: true, cwd, agentDir })).toThrow(/persona must be/);
});

it("task execute rejects an unknown after_task_id or persona before dispatching", async () => {
	const cwd = tempDir("hummin-personas-exec-");
	const task = loadTaskTool(cwd);
	const ctx = chainCtx(cwd);
	await expect(
		task.execute(
			"chain",
			{ prompt: "continue {previous}", after_task_id: "does-not-exist", model: "fleet-host/Org/Model" },
			undefined,
			undefined,
			ctx,
		),
	).rejects.toThrow(/Unknown task: does-not-exist/);
	await expect(
		task.execute(
			"persona",
			{ prompt: "x", persona: "missing-persona", model: "fleet-host/Org/Model" },
			undefined,
			undefined,
			ctx,
		),
	).rejects.toThrow(/Unknown persona: missing-persona/);
});

it("chains a finished task: the follow-up starts and the dispatch sees the interpolated brief", async () => {
	const cwd = tempDir("hummin-personas-chain-");
	const task = loadTaskTool(cwd);
	const ctx = chainCtx(cwd);
	// A prior task that is already finished with a captured report.
	const processes = new ProcessManager(join(cwd, "prior"), "task");
	const prior = processes.start({
		command: process.execPath,
		args: ["-e", "console.log('prior report')"],
		cwd,
		kind: "task",
		label: "prior",
		timeoutMs: 60_000,
	});
	await prior.done;
	const chained = await task.execute(
		"chain",
		{
			prompt: `Summarize this: ${"{previous}"}`,
			after_task_id: prior.id,
			model: "fleet-host/Org/Model",
			background: true,
		},
		undefined,
		undefined,
		ctx,
	);
	expect(chained.details).toHaveProperty("taskId");
	await processes.close();
});
