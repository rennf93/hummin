import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeAllProcesses,
	describeJob,
	formatDuration,
	type ProcessJob,
	ProcessManager,
	runningProcessCount,
} from "../extensions/lib/processes.ts";

function fakeJob(overrides: Partial<ProcessJob> = {}): ProcessJob {
	return {
		id: "4b104971-abcd-1234-5678-9abcdef01234",
		kind: "task",
		label: '"Fix flaky tests" · zai/glm-5.3-flash',
		logFile: "/tmp/hummin/4b104971.log",
		startedAt: Date.now() - 65_000,
		state: "running",
		exitCode: null,
		output: "",
		done: Promise.resolve(),
		stop: () => {},
		...overrides,
	};
}

describe("describeJob", () => {
	it("renders kind, id, label, running state, and log path", () => {
		const text = describeJob(fakeJob());
		expect(text).toContain("task 4b104971-abcd");
		expect(text).toContain('"Fix flaky tests" · zai/glm-5.3-flash');
		expect(text).toMatch(/running 1m5s/);
		expect(text).toContain("log: /tmp/hummin/4b104971.log");
		expect(text).not.toContain("exit");
	});

	it("renders exit code and duration for a finished job", () => {
		const job = fakeJob({ state: "failed", exitCode: 2, error: "boom" });
		const text = describeJob(job);
		expect(text).toContain("failed (exit 2, 1m5s)");
		expect(text).toContain("error: boom");
	});

	it("shows exit none for cancelled jobs", () => {
		const job = fakeJob({ state: "cancelled" });
		expect(describeJob(job)).toContain("cancelled (exit none,");
	});
});

describe("formatDuration", () => {
	it("formats seconds, minutes, and hours", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(65_000)).toBe("1m5s");
		expect(formatDuration(180_000)).toBe("3m");
		expect(formatDuration(3_780_000)).toBe("1h3m");
	});
});

describe("process registry", () => {
	let dir: string;
	let manager: ProcessManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "processes-test-"));
		manager = new ProcessManager(dir, "task");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports no background processes when idle", () => {
		expect(runningProcessCount()).toBe(0);
		expect(describeAllProcesses()).toBe("No background processes");
	});

	it("counts a live child process and clears it on completion", async () => {
		const job = manager.start({
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 150)"],
			cwd: dir,
			kind: "task",
			label: "test",
			timeoutMs: 5000,
		});
		expect(runningProcessCount()).toBe(1);
		expect(describeAllProcesses()).toContain("task ");
		await job.done;
		expect(runningProcessCount()).toBe(0);
		expect(job.state).toBe("completed");
	});
});
