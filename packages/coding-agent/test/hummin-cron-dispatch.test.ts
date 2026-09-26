import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSchedulerPass } from "../extensions/hummin-cron.ts";
import { type CronEntry, readCronStore, upsertEntry } from "../extensions/lib/cron-store.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function model(id: string, thinkingLevelMap: Record<string, string | null>): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "http://example.invalid",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		thinkingLevelMap,
		contextWindow: 131072,
		maxTokens: 8192,
	} as Model<Api>;
}

describe("cron child dispatch review", () => {
	it("holds strong dissent without spawning or advancing lastRun", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hummin-cron-review-"));
		dirs.push(dir);
		const entry: CronEntry = {
			name: "held",
			schedule: "every:5",
			cwd: dir,
			prompt: "debug the race",
			model: "fixture/expensive",
			thinking: "high",
			createdAt: 1,
		};
		upsertEntry(dir, entry);
		const notify = vi.fn();
		const result = await runSchedulerPass(dir, Date.now(), {
			modelRegistry: {
				getAvailable: () => [model("expensive", { high: "high" }), model("cheap", { off: "off" })],
			} as unknown as Parameters<typeof runSchedulerPass>[2] extends infer C
				? C extends { modelRegistry: infer R }
					? R
					: never
				: never,
			notify,
			// Hermetic: without explicit profiles the review falls back to the
			// machine's global settings, whose layaRightSize.profiles would drop
			// the fixture models from the catalog and skip the review entirely.
			reviewOptions: {
				agentDir: dir,
				profiles: [],
				laya: async () => [{ answer: "fixture/cheap [thinking=off]", p: 0.99 }],
			},
		});
		expect(result[0]).toMatch(/held for dispatch review/);
		expect(notify).toHaveBeenCalled();
		expect(readCronStore(dir).entries[0]?.lastRun).toBeUndefined();
	});

	it("uses approved provider/model/thinking argv when the review allows", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hummin-cron-review-"));
		dirs.push(dir);
		// Lesson inheritance must be a strict no-op when memory is off, so the
		// approved argv below stays byte-identical.
		vi.stubEnv("HUMMIN_MEMORY", "0");
		const recorder = join(dir, "child.cjs");
		const launcher = join(dir, "child");
		const output = join(dir, "argv.json");
		writeFileSync(
			recorder,
			`require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`);
		chmodSync(launcher, 0o755);
		vi.stubEnv("HUMMIN_CRON_BIN", launcher);
		const entry: CronEntry = {
			name: "allowed",
			schedule: "every:5",
			cwd: dir,
			prompt: "format this file",
			model: "fixture/expensive",
			thinking: "high",
			createdAt: 1,
		};
		upsertEntry(dir, entry);
		const spawned = await runSchedulerPass(dir, Date.now(), {
			modelRegistry: {
				getAvailable: () => [model("expensive", { high: "high" }), model("cheap", { low: "low" })],
			} as unknown as Parameters<typeof runSchedulerPass>[2] extends infer C
				? C extends { modelRegistry: infer R }
					? R
					: never
				: never,
			reviewOptions: {
				agentDir: dir,
				profiles: [],
				laya: async () => [{ answer: "fixture/cheap [thinking=low]", p: 0.55 }],
				config: { enabled: true, swingThreshold: 0.6 },
			},
		});
		expect(spawned[0]).toMatch(/spawned pid/);
		// The detached child writes argv.json on its own schedule; poll instead
		// of a fixed sleep so a loaded machine does not flake the assertion.
		let argv: unknown;
		for (let i = 0; i < 100; i++) {
			try {
				argv = JSON.parse(readFileSync(output, "utf8"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		expect(argv).toEqual([
			"-p",
			"format this file",
			"--session-dir",
			dir,
			"--model",
			"fixture/expensive",
			"--thinking",
			"high",
		]);
	});

	it("prepends inherited lessons to the child prompt when memory is on", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hummin-cron-review-"));
		dirs.push(dir);
		const memoryDir = mkdtempSync(join(tmpdir(), "hummin-cron-memory-"));
		dirs.push(memoryDir);
		vi.stubEnv("HUMMIN_MEMORY", "1");
		vi.stubEnv("HUMMIN_MEMORY_DIR", memoryDir);
		vi.stubEnv("HUMMIN_MEMORY_VAULT_DIR", mkdtempSync(join(tmpdir(), "hummin-cron-vault-")));
		// Seed one matching lesson: the brief recalls for process.cwd(), so the
		// lesson carries this cwd and overlaps the entry prompt's terms.
		writeFileSync(
			join(memoryDir, "lessons.jsonl"),
			`${JSON.stringify({
				cwd: process.cwd(),
				lesson: "Gotcha: always run the format script before committing a file move",
			})}\n`,
		);
		const recorder = join(dir, "child.cjs");
		const launcher = join(dir, "child");
		const output = join(dir, "argv.json");
		writeFileSync(
			recorder,
			`require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({
				argv: process.argv.slice(2),
				memory: process.env.HUMMIN_MEMORY,
				tools: process.env.HUMMIN_MEMORY_TOOLS,
			}));`,
		);
		writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`);
		chmodSync(launcher, 0o755);
		vi.stubEnv("HUMMIN_CRON_BIN", launcher);
		const entry: CronEntry = {
			name: "inheriting",
			schedule: "every:5",
			cwd: dir,
			prompt: "format this file",
			model: "fixture/expensive",
			thinking: "high",
			createdAt: 1,
		};
		upsertEntry(dir, entry);
		const spawned = await runSchedulerPass(dir, Date.now(), {
			modelRegistry: {
				getAvailable: () => [model("expensive", { high: "high" }), model("cheap", { low: "low" })],
			} as unknown as Parameters<typeof runSchedulerPass>[2] extends infer C
				? C extends { modelRegistry: infer R }
					? R
					: never
				: never,
			reviewOptions: {
				agentDir: dir,
				profiles: [],
				laya: async () => [{ answer: "fixture/cheap [thinking=low]", p: 0.55 }],
				config: { enabled: true, swingThreshold: 0.6 },
			},
		});
		expect(spawned[0]).toMatch(/spawned pid/);
		let child: { argv: string[]; memory?: string; tools?: string } | undefined;
		for (let i = 0; i < 100; i++) {
			try {
				child = JSON.parse(readFileSync(output, "utf8"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		expect(child).toBeDefined();
		// The child prompt is the entry prompt with the bounded inherited-lessons
		// block (the task tool's format) prepended.
		expect(child!.argv[0]).toBe("-p");
		expect(child!.argv[1]).toContain("Context inherited from the parent session");
		expect(child!.argv[1]).toContain("Gotcha: always run the format script before committing a file move");
		expect(child!.argv[1].endsWith("format this file")).toBe(true);
		// The rest of the approved argv is untouched (the 0.55 answer stays under
		// the 0.6 swing threshold, so expensive/high is kept), and the child
		// keeps memory writes off while the read-only vault tool stays available.
		expect(child!.argv.slice(2)).toEqual([
			"--session-dir",
			dir,
			"--model",
			"fixture/expensive",
			"--thinking",
			"high",
		]);
		expect(child!.memory).toBe("0");
		expect(child!.tools).toBe("1");
		// The stored entry keeps the bare prompt (each run re-recalls).
		expect(readCronStore(dir).entries[0]?.prompt).toBe("format this file");
	});
});
