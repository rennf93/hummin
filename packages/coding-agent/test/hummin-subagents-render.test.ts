import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildCollapsedRow,
	parseDuration,
	parseMonitorNotice,
	parseTaskCompletion,
	promptLabel,
	taskCallDetail,
} from "../extensions/hummin-subagents.ts";
import {
	allProcessJobs,
	backgroundPanelAction,
	dismissProcessJob,
	findProcessJob,
	type ProcessJob,
	ProcessManager,
} from "../extensions/lib/processes.ts";

const createdDirs: string[] = [];
function newDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("promptLabel", () => {
	it("collapses whitespace and trims", () => {
		expect(promptLabel("  Implement\nSlice 19\t(notification dedupe)  ")).toBe(
			"Implement Slice 19 (notification dedupe)",
		);
	});

	it("truncates long prompts with an ellipsis", () => {
		const long = "a".repeat(100);
		expect(promptLabel(long)).toBe(`${"a".repeat(72)}…`);
		expect(promptLabel(long).length).toBe(73);
	});

	it("falls back for empty prompts", () => {
		expect(promptLabel("   ")).toBe("(empty prompt)");
	});
});

describe("taskCallDetail", () => {
	it("shapes label-first detail with the model", () => {
		expect(taskCallDetail("Fix the thing", "zai/glm-5.3-flash")).toBe('"Fix the thing" · zai/glm-5.3-flash');
	});
});

describe("buildCollapsedRow", () => {
	it("joins label and detail with two spaces, matching built-in tool rows", () => {
		const row = buildCollapsedRow(40, "Task", '"x"', "  · running");
		expect(row.startsWith('Task  "x"')).toBe(true);
		expect(row.endsWith("· running")).toBe(true);
		const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible.length).toBeLessThanOrEqual(40);
	});

	it("does not pad the label to a fixed width", () => {
		// Regression: the Task row used padEnd(12), leaving a wide gap before
		// the detail compared with the built-in Bash row.
		const row = buildCollapsedRow(80, "Task", '"x"', "");
		expect(row.startsWith('Task  "x"')).toBe(true);
	});

	it("truncates with an ellipsis when the detail overflows", () => {
		const row = buildCollapsedRow(20, "Task", `"${"y".repeat(60)}"`, "");
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain.length).toBe(20);
		expect(plain.endsWith("…")).toBe(true);
	});
});

describe("parseDuration", () => {
	it("parses compound durations", () => {
		expect(parseDuration("2m14s")).toBe(134_000);
		expect(parseDuration("45s")).toBe(45_000);
		expect(parseDuration("1h3m5s")).toBe(3_785_000);
	});

	it("returns null for non-durations", () => {
		expect(parseDuration("none")).toBeNull();
	});
});

describe("parseTaskCompletion", () => {
	it("prefers the structured details object", () => {
		const info = parseTaskCompletion("ignored", {
			label: '"Fix the thing"',
			model: "zai/glm-5.3-flash",
			state: "completed",
			exitCode: 0,
			durationMs: 134_000,
		});
		expect(info).toEqual({
			label: '"Fix the thing"',
			model: "zai/glm-5.3-flash",
			state: "completed",
			exitCode: 0,
			durationMs: 134_000,
		});
	});

	it("falls back to parsing describeJob text", () => {
		const text = 'task t1 · "Fix the thing" · zai/glm-5.3-flash · completed (exit 0, 2m14s)\nlog: /tmp/x.log';
		const info = parseTaskCompletion(text);
		expect(info.label).toBe('"Fix the thing" · zai/glm-5.3-flash');
		expect(info.state).toBe("completed");
		expect(info.exitCode).toBe(0);
		expect(info.durationMs).toBe(134_000);
	});

	it("parses failures with no duration", () => {
		const info = parseTaskCompletion('task t2 · "x" · failed (exit 1)');
		expect(info.state).toBe("failed");
		expect(info.exitCode).toBe(1);
		expect(info.durationMs).toBeNull();
	});
});

describe("parseMonitorNotice", () => {
	it("parses output notifications with line counts", () => {
		const info = parseMonitorNotice("Monitor m1 output (untrusted command data):\nline1\nline2\nline3");
		expect(info.kind).toBe("output");
		expect(info.id).toBe("m1");
		expect(info.lines).toBe(3);
		expect(info.detail).toBe("m1");
	});

	it("parses empty output notifications", () => {
		const info = parseMonitorNotice("Monitor m1 output (untrusted command data):\n");
		expect(info.lines).toBe(0);
	});

	it("parses lifecycle notifications", () => {
		const info = parseMonitorNotice("Monitor m1: completed (exit 0) ");
		expect(info.kind).toBe("lifecycle");
		expect(info.state).toBe("completed");
		expect(info.exitCode).toBe(0);
		expect(info.detail).toBe("completed (exit 0)");
	});

	it("parses lifecycle notifications without an exit code", () => {
		const info = parseMonitorNotice("Monitor m1: cancelled");
		expect(info.state).toBe("cancelled");
		expect(info.exitCode).toBeNull();
		expect(info.detail).toBe("cancelled (exit none)");
	});
});

describe("background panel ctrl+x semantics", () => {
	it("stop for running jobs, remove for terminal jobs, undefined for unknown", () => {
		const running = { id: "a", state: "running" } as unknown as ProcessJob;
		const completed = { id: "b", state: "completed" } as unknown as ProcessJob;
		expect(backgroundPanelAction(running)).toBe("stop");
		expect(backgroundPanelAction(completed)).toBe("remove");
		expect(backgroundPanelAction(undefined)).toBeUndefined();
	});

	it("dismissProcessJob clears terminal jobs from listings and refuses running ones", async () => {
		const manager = new ProcessManager(newDirectory("hummin-dismiss-"), "task");
		const noop = (): void => undefined;
		const runningJob = manager.start({
			command: "sleep",
			args: ["5"],
			cwd: newDirectory("hummin-dismiss-"),
			kind: "task",
			label: "live",
			timeoutMs: 60_000,
			onOutput: noop,
		});
		expect(dismissProcessJob(runningJob.id)).toBe(false);
		await runningJob.stop();
		expect(dismissProcessJob(runningJob.id)).toBe(true);
		// The record stays for lookup but is hidden from every listing.
		expect(findProcessJob(runningJob.id)?.dismissed).toBe(true);
		expect(allProcessJobs().some((job) => job.id === runningJob.id)).toBe(false);
		await manager.close();
	});
});
