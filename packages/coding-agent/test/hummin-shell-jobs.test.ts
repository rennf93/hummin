import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import humminMonitor, { monitorNameJobId } from "../extensions/hummin-monitor.ts";
import humminShellJobs, { isShellJob, shellJobText } from "../extensions/hummin-shell-jobs.ts";
import { type ProcessJob, ProcessManager } from "../extensions/lib/processes.ts";

let directory: string;
let manager: ProcessManager;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-shell-jobs-"));
	manager = new ProcessManager(join(directory, "exec"), "exec");
});
afterEach(async () => {
	await manager.close();
	rmSync(directory, { recursive: true, force: true });
});

const job = (overrides: Partial<ProcessJob> = {}): ProcessJob =>
	({
		id: "job-1",
		kind: "exec",
		label: "echo hi",
		logFile: join(directory, "job-1.log"),
		startedAt: Date.now() - 5000,
		state: "completed",
		exitCode: 0,
		output: "line 1\nline 2\nline 3",
		done: Promise.resolve(),
		stop: () => {},
		...overrides,
	}) as ProcessJob;

describe("isShellJob", () => {
	it("serves exec and monitor kinds and refuses others", () => {
		expect(isShellJob(job({ kind: "exec" }))).toBe(true);
		expect(isShellJob(job({ kind: "monitor" }))).toBe(true);
		expect(isShellJob(job({ kind: "task" }))).toBe(false);
		expect(isShellJob(job({ kind: "cron" }))).toBe(false);
	});
});

describe("shellJobText", () => {
	it("composes status, log path, error, and a bounded output tail", () => {
		const text = shellJobText(
			job({ error: "something failed", output: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") }),
		);
		expect(text).toContain("exec job-1 · echo hi · completed (exit 0,");
		expect(text).toContain("log: ");
		expect(text).toContain("error: something failed");
		expect(text).toContain("output tail (untrusted command data):");
		// tail only: early lines are not in the result, the last line is
		expect(text).not.toContain("line 0\n");
		expect(text.trimEnd().endsWith("line 49")).toBe(true);
	});

	it("falls back to (no output) when nothing was captured", () => {
		expect(shellJobText(job({ output: "" }))).toContain("output tail (untrusted command data):\n(no output)");
	});
});

describe("job tools", () => {
	function fakePi(): {
		api: ExtensionAPI;
		tools: Map<
			string,
			{
				execute: (
					id: string,
					params: unknown,
					signal: undefined,
					update: undefined,
					ctx: ExtensionContext,
				) => Promise<unknown>;
			}
		>;
	} {
		const tools = new Map();
		const api = {
			registerTool: (tool: { name: string }) => {
				tools.set(tool.name, tool as never);
			},
			on: () => () => {},
		} as unknown as ExtensionAPI;
		return { api, tools };
	}

	const ctx = { ui: {} } as unknown as ExtensionContext;
	const text = (result: unknown): string => (result as { content: { text: string }[] }).content[0].text;

	it("registers job_output and job_stop", () => {
		const { api, tools } = fakePi();
		humminShellJobs(api);
		expect([...tools.keys()].sort()).toEqual(["job_output", "job_stop"]);
	});

	it("job_output polls a running exec job's state and tail", async () => {
		const { api, tools } = fakePi();
		humminShellJobs(api);
		const started = manager.start({
			command: "sh",
			args: ["-c", "echo spawned-output; sleep 30"],
			cwd: directory,
			kind: "exec",
			label: "sleep",
			timeoutMs: 60_000,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			const output = await tools.get("job_output")!.execute("t", { job_id: started.id }, undefined, undefined, ctx);
			expect(text(output)).toContain(`exec ${started.id} · sleep · running`);
			expect(text(output)).toContain("spawned-output");
		} finally {
			started.stop();
			await started.done;
		}
	});

	it("honors the lines parameter instead of always returning the default tail", async () => {
		const { api, tools } = fakePi();
		humminShellJobs(api);
		const started = manager.start({
			command: "sh",
			args: ["-c", 'i=0; while [ $i -lt 40 ]; do echo "line $i"; i=$((i+1)); done; sleep 30'],
			cwd: directory,
			kind: "exec",
			label: "numbered",
			timeoutMs: 60_000,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const output = await tools
				.get("job_output")!
				.execute("t", { job_id: started.id, lines: 5 }, undefined, undefined, ctx);
			expect(text(output)).toContain("line 39");
			expect(text(output)).not.toContain("line 5\n");
		} finally {
			started.stop();
			await started.done;
		}
	});

	it("char-caps a tail made of one giant line", async () => {
		const { api, tools } = fakePi();
		humminShellJobs(api);
		const started = manager.start({
			command: "sh",
			args: ["-c", "printf 'x%.0s' $(seq 1 9000); sleep 30"],
			cwd: directory,
			kind: "exec",
			label: "giant line",
			timeoutMs: 60_000,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const output = await tools.get("job_output")!.execute("t", { job_id: started.id }, undefined, undefined, ctx);
			expect(text(output)).toContain("[truncated, showing the last 8000 of 9000 chars");
		} finally {
			started.stop();
			await started.done;
		}
	});

	it("resolves monitor/exec nicknames and job_stop cleans them up", async () => {
		const { api: monitorApi, tools: monitorTools } = fakePi();
		humminMonitor(monitorApi);
		const execTool = monitorTools.get("exec")!;
		const started = (await execTool.execute(
			"t",
			{ command: "echo probe-output; sleep 30", name: "probe", timeout_sec: 60 },
			undefined,
			undefined,
			{ isProjectTrusted: () => true, cwd: directory, ui: {} } as unknown as ExtensionContext,
		)) as { details: { execId: string } };
		expect(started.details.execId).toBeTruthy();
		expect(monitorNameJobId("probe")).toBe(started.details.execId);
		const { api, tools } = fakePi();
		humminShellJobs(api);
		const polled = await tools.get("job_output")!.execute("t", { job_id: "probe" }, undefined, undefined, ctx);
		expect(text(polled)).toContain("probe-output");
		await tools.get("job_stop")!.execute("t", { job_id: "probe" }, undefined, undefined, ctx);
		expect(monitorNameJobId("probe")).toBeUndefined();
	});

	it("job_stop cancels a running exec job and reports the final state", async () => {
		const { api, tools } = fakePi();
		humminShellJobs(api);
		const started = manager.start({
			command: "sleep",
			args: ["30"],
			cwd: directory,
			kind: "exec",
			label: "sleep 30",
			timeoutMs: 60_000,
		});
		const stopped = await tools.get("job_stop")!.execute("t", { job_id: started.id }, undefined, undefined, ctx);
		expect(started.state).toBe("cancelled");
		expect(text(stopped)).toContain("cancelled");
	});

	it("refuses task-kind and unknown ids instead of touching them", async () => {
		const { api, tools } = fakePi();
		humminShellJobs(api);
		await expect(
			tools.get("job_output")!.execute("t", { job_id: "nope" }, undefined, undefined, ctx),
		).rejects.toThrow(/Unknown background shell job/);
		const taskJob = manager.start({
			command: "true",
			args: [],
			cwd: directory,
			kind: "task",
			label: "a subagent job",
			timeoutMs: 10_000,
		});
		await taskJob.done;
		await expect(
			tools.get("job_output")!.execute("t", { job_id: taskJob.id }, undefined, undefined, ctx),
		).rejects.toThrow(/task_status/);
		await expect(
			tools.get("job_stop")!.execute("t", { job_id: taskJob.id }, undefined, undefined, ctx),
		).rejects.toThrow(/task_cancel/);
	});
});
