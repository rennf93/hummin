import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	childReportExcerpt,
	TASK_REPORT_MAX_CHARS,
	taskResultText,
	withInheritedLessons,
} from "../extensions/hummin-subagents.ts";
import { type ProcessJob, ProcessManager } from "../extensions/lib/processes.ts";

const createdDirs: string[] = [];
function newDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("childReportExcerpt", () => {
	it("returns short output unchanged with trailing whitespace trimmed", () => {
		expect(childReportExcerpt("report body\n\n", "/log/x.log")).toBe("report body");
	});

	it("returns empty output as empty string", () => {
		expect(childReportExcerpt("", "/log/x.log")).toBe("");
	});

	it("keeps the tail of long output behind an explicit notice", () => {
		const output = `${"a".repeat(9000)}END`;
		const excerpt = childReportExcerpt(output, "/log/x.log");
		expect(TASK_REPORT_MAX_CHARS).toBe(8000);
		expect(
			excerpt.startsWith(`[truncated, showing the last 8000 of ${output.length} chars; full output: /log/x.log]`),
		).toBe(true);
		expect(excerpt.endsWith("END")).toBe(true);
	});

	it("honors a custom char budget", () => {
		const excerpt = childReportExcerpt("abcdef", "/log/x.log", 4);
		expect(excerpt).toBe(`[truncated, showing the last 4 of 6 chars; full output: /log/x.log]\ncdef`);
	});
});

describe("withInheritedLessons", () => {
	it("returns the prompt unchanged when there are no lessons", () => {
		expect(withInheritedLessons("do the thing", null)).toBe("do the thing");
		expect(withInheritedLessons("do the thing", "")).toBe("do the thing");
	});

	it("prepends the lessons block separated from the brief", () => {
		expect(withInheritedLessons("do the thing", "- lesson one")).toBe(
			"Context inherited from the parent session (may or may not be relevant):\n- lesson one\n\n---\n\ndo the thing",
		);
	});
});

describe("taskResultText", () => {
	it("keeps the live describeJob shape while running", async () => {
		const manager = new ProcessManager(newDirectory("hummin-report-"), "task");
		const job = manager.start({
			command: "sleep",
			args: ["5"],
			cwd: newDirectory("hummin-report-"),
			kind: "task",
			label: "live",
			timeoutMs: 60_000,
		});
		try {
			const text = taskResultText(job);
			expect(text).toContain(`task ${job.id} · live · running`);
			expect(text).toContain(`log: ${job.logFile}`);
			expect(text).not.toContain("Child final report");
		} finally {
			job.stop();
			await job.done;
			await manager.close();
		}
	});

	it("appends the child's bounded final report after completion", async () => {
		const manager = new ProcessManager(newDirectory("hummin-report-"), "task");
		const job = manager.start({
			command: "echo",
			args: ["FINAL REPORT"],
			cwd: newDirectory("hummin-report-"),
			kind: "task",
			label: "echo",
			timeoutMs: 60_000,
		});
		await job.done;
		await manager.close();
		const text = taskResultText(job);
		expect(text).toContain(`task ${job.id} · echo · completed (exit 0`);
		expect(text).toContain(`log: ${job.logFile}`);
		expect(text).toContain("Child final report (tail of captured output):");
		expect(text.trimEnd().endsWith("FINAL REPORT")).toBe(true);
	});

	it("falls back to the bare status header when the log is unreadable", () => {
		const job = {
			id: "t1",
			kind: "task",
			label: '"gone"',
			logFile: join(newDirectory("hummin-report-"), "missing.log"),
			startedAt: Date.now(),
			state: "failed",
			exitCode: 1,
			output: "",
		} as unknown as ProcessJob;
		const text = taskResultText(job);
		expect(text).toContain(`task t1 · ${job.label} · failed (exit 1`);
		expect(text).not.toContain("Child final report");
	});
});
