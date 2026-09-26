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
});
