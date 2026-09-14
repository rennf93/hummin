/**
 * hummin-subagents: the Task tool.
 *
 * Spawns `hummin -p` child sessions with their own prompt, cwd, model, and
 * timeout. Hard rules baked in:
 * - Child env gets HUMMIN_MEMORY=0 (recursion bug class).
 * - We hold the exact child PID we spawned (never kill by name pattern).
 * - Local-model subagents are serialized (one per server: single generation
 *   slot) so they cannot starve the interactive session.
 * - Default model is the cloud fast lane (zai) - a local-model parent plus a
 *   local-model child would collide on the same server's slot.
 *
 * task runs synchronously and returns the transcript tail; task with
 * background:true returns a task id immediately, and task_status polls it.
 * Output is always appended to ~/.hummin/agent/subagents/<id>.log.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_DIR = join(process.env.HUMMIN_AGENT_DIR ?? join(homedir(), ".hummin", "agent"), "subagents");
const DEFAULT_TIMEOUT_MS = 600_000;
const TAIL_CHARS = 4000;

interface SubagentTask {
	id: string;
	pid: number | undefined;
	prompt: string;
	cwd: string;
	provider: string;
	modelId: string;
	logFile: string;
	startedAt: number;
	timeoutMs: number;
	timer: NodeJS.Timeout | undefined;
	exited: boolean;
	exitCode: number | null;
}

const tasks = new Map<string, SubagentTask>();
// Local (colibri) subagents serialize: one at a time per the single generation slot.
let localTaskRunning = false;

function newId(): string {
	return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function resolveModel(requested?: string): { provider: string; modelId: string; local: boolean } {
	const value = (requested ?? "fast").toLowerCase();
	if (value === "local") return { provider: "colibri", modelId: "qwen3.8-27b", local: true };
	if (value === "fast" || value === "") return { provider: "zai", modelId: "glm-5.3-flash", local: false };
	return { provider: value, modelId: value, local: false };
}

function tail(logFile: string, chars: number = TAIL_CHARS): string {
	if (!existsSync(logFile)) return "(no output yet)";
	const content = readFileSync(logFile, "utf8");
	return content.length <= chars ? content : `...${content.slice(-chars)}`;
}

function timeoutKill(task: SubagentTask): void {
	if (task.pid !== undefined) {
		try {
			process.kill(task.pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
}

export default function humminSubagents(pi: ExtensionAPI): void {
	mkdirSync(SUBAGENT_DIR, { recursive: true });

	pi.registerTool({
		name: "task",
		label: "Task (subagent)",
		description:
			"Spawn a subagent hummin session to do a bounded piece of work independently and return its final output. Use for parallelizable research, analysis, or self-contained implementation briefs. The subagent cannot see this conversation - write a complete, self-sufficient prompt.",
		promptSnippet: "task: spawn an independent subagent hummin session (own prompt/cwd/model/timeout)",
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete, self-sufficient brief for the subagent (it sees nothing else)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			model: Type.Optional(
				Type.String({
					description:
						"'fast' (cloud zai, default), 'local' (colibri qwen3.8-27b, serialized), or provider/model id",
				}),
			),
			timeout_sec: Type.Optional(Type.Number({ description: "Kill after this many seconds (default 600)" })),
			background: Type.Optional(
				Type.Boolean({ description: "true: return a task id immediately; poll with task_status" }),
			),
		}),

		async execute(_toolCallId, params) {
			const id = newId();
			const logFile = join(SUBAGENT_DIR, `${id}.log`);
			const { provider, modelId, local } = resolveModel(params.model);
			const cwd = params.cwd && existsSync(params.cwd) ? params.cwd : process.cwd();
			const timeoutMs = (params.timeout_sec ?? 600) * 1000;

			if (local && localTaskRunning) {
				return {
					content: [
						{
							type: "text",
							text: "Error: a local-model subagent is already running (single generation slot). Wait for it or use model='fast'.",
						},
					],
					isError: true,
				};
			}

			const task: SubagentTask = {
				id,
				pid: undefined,
				prompt: params.prompt,
				cwd,
				provider,
				modelId,
				logFile,
				startedAt: Date.now(),
				timeoutMs,
				timer: undefined,
				exited: false,
				exitCode: null,
			};
			tasks.set(id, task);
			if (local) localTaskRunning = true;

			const child = spawn(
				"hummin",
				["-p", params.prompt, "--provider", provider, "--model", modelId, "--thinking", "off"],
				{
					cwd,
					env: { ...process.env, HUMMIN_MEMORY: "0" },
					stdio: ["ignore", appendFileSync(logFile, ""), appendFileSync(logFile, "")],
				},
			);
			task.pid = child.pid;

			child.on("exit", (code) => {
				task.exited = true;
				task.exitCode = code;
				if (local) localTaskRunning = false;
				if (task.timer) clearTimeout(task.timer);
			});

			task.timer = setTimeout(() => {
				if (!task.exited) timeoutKill(task);
			}, timeoutMs);

			if (params.background) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent ${id} started in background (provider: ${provider}, model: ${modelId}). Poll with task_status(task_id: "${id}"). Log: ${logFile}`,
						},
					],
				};
			}

			// Synchronous: wait for exit (timeout enforced by the timer's kill).
			const exitCode = await new Promise<number | null>((resolve) => {
				child.on("exit", (code) => resolve(code));
			});
			const output = tail(logFile);
			return {
				content: [
					{
						type: "text",
						text: `Subagent ${id} finished (exit ${exitCode ?? "unknown"}, ${Math.round((Date.now() - task.startedAt) / 1000)}s):\n\n${output}`,
					},
				],
				isError: exitCode !== 0,
			};
		},
	});

	pi.registerTool({
		name: "task_status",
		label: "Task Status",
		description: "Poll a background subagent started with task(background: true). Returns done state and output tail.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The subagent task id" }),
		}),
		async execute(_toolCallId, params) {
			const task = tasks.get(params.task_id);
			if (!task) {
				return { content: [{ type: "text", text: `Unknown task id: ${params.task_id}` }], isError: true };
			}
			const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
			const state = task.exited ? `exited (code ${task.exitCode ?? "unknown"})` : "running";
			return {
				content: [
					{
						type: "text",
						text: `Subagent ${task.id}: ${state}, ${elapsed}s elapsed, ${task.provider}/${task.modelId}\n\n${tail(task.logFile)}`,
					},
				],
			};
		},
	});
}
