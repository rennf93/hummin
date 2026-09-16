import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorBuffer } from "../extensions/hummin-monitor.ts";
import { resolveTaskModel } from "../extensions/hummin-subagents.ts";
import { ProcessManager } from "../extensions/lib/processes.ts";

const directories: string[] = [];
const managers: ProcessManager[] = [];
function fixture(source: string) {
	const cwd = mkdtempSync(join(tmpdir(), "hummin-process-"));
	directories.push(cwd);
	const script = join(cwd, "child.mjs");
	writeFileSync(script, source);
	const manager = new ProcessManager(join(cwd, "logs"), "task");
	managers.push(manager);
	return {
		manager,
		options: { command: process.execPath, args: [script], cwd, kind: "task", label: "test", timeoutMs: 5000 },
	};
}
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("owned child processes", () => {
	it("captures stdout and stderr and disables recursive memory", async () => {
		const { manager, options } = fixture('console.log(process.env.HUMMIN_MEMORY); console.error("stderr");');
		const job = manager.start(options);
		await job.done;
		expect(job.state).toBe("completed");
		expect(readFileSync(job.logFile, "utf8")).toContain("0\n");
		expect(job.output).toContain("stderr");
	});
	it("settles a failed spawn and can run another task", async () => {
		const { manager, options } = fixture('console.log("ok");');
		const failed = manager.start({ ...options, command: join(options.cwd, "absent") });
		await failed.done;
		expect(failed.state).toBe("failed");
		expect(failed.error).toContain("ENOENT");
		const next = manager.start(options);
		await next.done;
		expect(next.state).toBe("completed");
	});
	it("cancels only the requested child and preserves final output", async () => {
		const { manager, options } = fixture('console.log("ready"); setInterval(() => {}, 100);');
		const one = manager.start(options);
		const two = manager.start(options);
		await expect.poll(() => one.output).toContain("ready");
		one.stop();
		await one.done;
		expect(one.state).toBe("cancelled");
		expect(two.state).toBe("running");
	});
	it("times out and escalates a child that ignores TERM", async () => {
		const { manager, options } = fixture(
			'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 100);',
		);
		const job = manager.start({ ...options, timeoutMs: 400 });
		await job.done;
		expect(job.state).toBe("timed_out");
	});
	it("aborts running work and rejects already aborted work", async () => {
		const { manager, options } = fixture("setInterval(() => {}, 100);");
		const controller = new AbortController();
		const job = manager.start({ ...options, signal: controller.signal });
		controller.abort();
		await job.done;
		expect(job.state).toBe("cancelled");
		expect(() => manager.start({ ...options, signal: controller.signal })).toThrow();
	});
	it("drains large output while bounding retained data", async () => {
		const { manager, options } = fixture('process.stdout.write("x".repeat(2 * 1024 * 1024));');
		const job = manager.start(options);
		await job.done;
		expect(job.state).toBe("completed");
		expect(job.output.length).toBe(8000);
		expect(readFileSync(job.logFile).length).toBe(1024 * 1024);
	});
});

describe("monitor batches", () => {
	it("handles split lines, literal filters, duplicate suppression and final fragments", () => {
		const buffer = new MonitorBuffer("error");
		buffer.push("ok\nerr");
		buffer.push("or A\nerror A\nerror B");
		expect(buffer.flush()).toBe("error A");
		expect(buffer.flush(true)).toBe("error B");
		expect(buffer.flush()).toBe("");
	});
	it("bounds noisy output", () => {
		const buffer = new MonitorBuffer();
		buffer.push(Array.from({ length: 1000 }, (_, i) => `${i} ${"x".repeat(1000)}\n`).join(""));
		expect(buffer.flush().length).toBeLessThan(4100);
	});
});

describe("subagent model routing", () => {
	const models = [
		{ provider: "llamacpp-first-9000", id: "offline", humminHost: "first", humminOffline: true },
		{ provider: "llamacpp-second-9000", id: "Org/Model", humminHost: "second", humminOffline: false },
		{ provider: "zai", id: "glm-5.3-flash" },
	];
	const ctx = { modelRegistry: { getAvailable: () => models } } as unknown as Parameters<typeof resolveTaskModel>[1];
	it("chooses the first online fleet entry and preserves exact IDs", () => {
		expect(resolveTaskModel("local", ctx)).toBe(models[1]);
		expect(resolveTaskModel("llamacpp-second-9000/Org/Model", ctx)).toBe(models[1]);
		expect(resolveTaskModel(undefined, ctx)).toBe(models[2]);
	});
	it("rejects unknown and offline models", () => {
		expect(() => resolveTaskModel("hummin", ctx)).toThrow();
		expect(() => resolveTaskModel("llamacpp-first-9000/offline", ctx)).toThrow("offline");
	});
});
