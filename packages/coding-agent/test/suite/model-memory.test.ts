import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const agentDirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const agentDir of agentDirs.splice(0)) rmSync(agentDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function createAgentDir(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "hummin-model-memory-"));
	agentDirs.push(agentDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	return agentDir;
}

function setProject(harness: Harness, project: string): void {
	vi.spyOn(harness.sessionManager, "getCwd").mockReturnValue(project);
}

it("restores only the remembered model for the current project", async () => {
	createAgentDir();
	const projectA = "/tmp/hummin-project-a";
	const projectB = "/tmp/hummin-project-b";

	const source = await createHarness({
		models: [
			{ id: "faux-1", name: "One", reasoning: true },
			{ id: "faux-2", name: "Two", reasoning: true },
		],
	});
	setProject(source, projectA);
	await source.session.setModel(source.getModel("faux-2")!);
	source.cleanup();

	const target = await createHarness({
		models: [
			{ id: "faux-1", name: "One", reasoning: true },
			{ id: "faux-2", name: "Two", reasoning: true },
		],
		settings: { defaultProvider: "faux", defaultModel: "faux-1" },
	});
	harnesses.push(target);
	setProject(target, projectB);
	await target.session.restoreRememberedModel();
	expect(target.session.model?.id).toBe("faux-1");

	setProject(target, projectA);
	await target.session.restoreRememberedModel();
	expect(target.session.model?.id).toBe("faux-2");
	expect(target.settingsManager.getDefaultProvider()).toBe("faux");
	expect(target.settingsManager.getDefaultModel()).toBe("faux-1");
});

it("skips remembered models that are unavailable or unauthenticated", async () => {
	createAgentDir();
	const unavailableProject = "/tmp/hummin-unavailable-project";
	const authProject = "/tmp/hummin-auth-project";

	const source = await createHarness({
		models: [
			{ id: "faux-1", name: "One", reasoning: true },
			{ id: "faux-2", name: "Two", reasoning: true },
		],
	});
	setProject(source, unavailableProject);
	await source.session.setModel(source.getModel("faux-2")!);
	setProject(source, authProject);
	await source.session.setModel(source.getModel("faux-2")!);
	source.cleanup();

	const unavailable = await createHarness({
		models: [{ id: "faux-1", name: "One", reasoning: true }],
		settings: { defaultProvider: "faux", defaultModel: "faux-1" },
	});
	harnesses.push(unavailable);
	setProject(unavailable, unavailableProject);
	await unavailable.session.restoreRememberedModel();
	expect(unavailable.session.model?.id).toBe("faux-1");
	expect(unavailable.settingsManager.getDefaultModel()).toBe("faux-1");

	const unauthenticated = await createHarness({
		models: [
			{ id: "faux-1", name: "One", reasoning: true },
			{ id: "faux-2", name: "Two", reasoning: true },
		],
		settings: { defaultProvider: "faux", defaultModel: "faux-1" },
	});
	harnesses.push(unauthenticated);
	setProject(unauthenticated, authProject);
	await unauthenticated.authStorage.delete(unauthenticated.getModel().provider);
	await unauthenticated.session.restoreRememberedModel();
	expect(unauthenticated.session.model?.id).toBe("faux-1");
	expect(unauthenticated.settingsManager.getDefaultModel()).toBe("faux-1");
});

it("ignores malformed model memory without changing defaults", async () => {
	const agentDir = createAgentDir();
	const historyDir = join(agentDir, "history");
	mkdirSync(historyDir, { recursive: true });
	writeFileSync(join(historyDir, "model-memory.json"), "{not valid json");

	const harness = await createHarness({
		models: [{ id: "faux-1", name: "One", reasoning: true }],
		settings: { defaultProvider: "faux", defaultModel: "faux-1" },
	});
	harnesses.push(harness);
	setProject(harness, "/tmp/hummin-malformed-project");
	await expect(harness.session.restoreRememberedModel()).resolves.toBeUndefined();
	expect(harness.session.model?.id).toBe("faux-1");
	expect(harness.settingsManager.getDefaultProvider()).toBe("faux");
	expect(harness.settingsManager.getDefaultModel()).toBe("faux-1");
});
