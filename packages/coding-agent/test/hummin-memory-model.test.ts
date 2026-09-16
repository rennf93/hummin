import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Vault/digest calls (fold, distill) follow the session's selected model and
 * fall back to zai/glm-5.3-flash. The env-over-settings precedence lives in
 * the SettingsManager getters; the extension mirrors it with its own
 * HUMMIN_MEMORY_* env checks before consulting these.
 */
describe("memory provider/model settings", () => {
	const testDir = join(process.cwd(), "test-memory-model-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const keys = ["HUMMIN_MEMORY_PROVIDER", "HUMMIN_MEMORY_MODEL_ID"] as const;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		for (const key of keys) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("defaults to zai/glm-5.3-flash when nothing is configured", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getMemoryProvider()).toBe("zai");
		expect(manager.getMemoryModelId()).toBe("glm-5.3-flash");
	});

	it("reads values from settings.json", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ memoryProvider: "hummin", memoryModelId: "qwen3.8-27b" }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getMemoryProvider()).toBe("hummin");
		expect(manager.getMemoryModelId()).toBe("qwen3.8-27b");
	});

	it("env overrides settings (explicit pin wins)", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ memoryProvider: "hummin", memoryModelId: "qwen3.8-27b" }),
		);
		process.env.HUMMIN_MEMORY_PROVIDER = "zai";
		process.env.HUMMIN_MEMORY_MODEL_ID = "glm-5.3-flash";
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getMemoryProvider()).toBe("zai");
		expect(manager.getMemoryModelId()).toBe("glm-5.3-flash");
	});
});
