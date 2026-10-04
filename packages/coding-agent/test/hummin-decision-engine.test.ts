import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ENGINE_DEFAULTS, resolveDecisionEngine, sys1Disabled, sys1Noul } from "../extensions/lib/decision-engine.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";

// Engine resolution for the System-1 layer. Resolution order per field:
// HUMMIN_DECISION_* env > settings decision.* > defaults. Every test pins env
// and the agent dir explicitly: the module reads env at call time and
// settings through SettingsManager, so unpinned values would leak the
// developer's real environment into the assertions.

const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = [
	"HUMMIN_DECISION_URL",
	"HUMMIN_DECISION_API_KEY",
	"HUMMIN_DECISION_GATE_THRESHOLD",
	"HUMMIN_DECISION_STEER_THRESHOLD",
	"HUMMIN_DECISION_TRIAGE_THRESHOLD",
	"HUMMIN_DECISION_INTAKE_THRESHOLD",
	"HUMMIN_SYS1_GATE",
	"COLI_API_KEY",
];

const createdDirs: string[] = [];
let savedAgentDir: string | undefined;

beforeEach(() => {
	for (const name of ENV_NAMES) {
		savedEnv[name] = process.env[name];
		delete process.env[name];
	}
	savedAgentDir = process.env[ENV_AGENT_DIR];
	const agentDir = mkdtempSync(join(tmpdir(), "sys1-engine-agent-"));
	createdDirs.push(agentDir);
	process.env[ENV_AGENT_DIR] = agentDir;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp project dir with a settings.json; resolveDecisionEngine(dir) reads
 * the decision namespace through the real SettingsManager loader against
 * that project. The config dir name comes from the package's piConfig
 * (.hummin in this fork). */
function projectWithSettings(settings: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "sys1-engine-project-"));
	createdDirs.push(dir);
	mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(dir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(settings));
	return dir;
}

test("defaults resolve to the calibrated sys1 engine profile", () => {
	const engine = resolveDecisionEngine();
	expect(engine.url).toBe("http://127.0.0.1:9987/v1/systemone");
	expect(engine.gateThreshold).toBe(0.75);
	expect(engine.steerThreshold).toBe(0.8);
	expect(engine.triageThreshold).toBe(0.45);
	expect(engine.intakeThreshold).toBe(0.5);
	expect(engine.gateTimeoutMs).toBe(8000);
	expect(engine.dispatchTimeoutMs).toBe(6000);
	expect(engine.decideTimeoutMs).toBe(120000);
	expect(engine.unconfigured).toBe(false);
});

test("ENGINE_DEFAULTS carries the recalibrated lines", () => {
	// The 2026-10-03 probe matrix: the gate line stays 0.75, steer moved to
	// 0.8 so a benign 0.733 prompt does not fire, triage and intake keep
	// their lines, gate timeout 8s.
	expect(ENGINE_DEFAULTS.gateThreshold).toBe(0.75);
	expect(ENGINE_DEFAULTS.steerThreshold).toBe(0.8);
	expect(ENGINE_DEFAULTS.triageThreshold).toBe(0.45);
	expect(ENGINE_DEFAULTS.intakeThreshold).toBe(0.5);
	expect(ENGINE_DEFAULTS.gateTimeoutMs).toBe(8000);
});

test("HUMMIN_DECISION_URL and HUMMIN_DECISION_API_KEY override the defaults", () => {
	process.env.HUMMIN_DECISION_URL = "http://fleet:9993/v1/systemone";
	process.env.HUMMIN_DECISION_API_KEY = "fleet-key";
	const engine = resolveDecisionEngine();
	expect(engine.url).toBe("http://fleet:9993/v1/systemone");
	expect(engine.apiKey).toBe("fleet-key");
});

test("out-of-range env thresholds are ignored, not trusted", () => {
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "1.5";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.75);
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "not-a-number";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.75);
});

test("COLI_API_KEY is the legacy fleet credential fallback; explicit key wins", () => {
	process.env.COLI_API_KEY = "shared-key";
	expect(resolveDecisionEngine().apiKey).toBe("shared-key");
	process.env.HUMMIN_DECISION_API_KEY = "explicit-key";
	expect(resolveDecisionEngine().apiKey).toBe("explicit-key");
});

test("sys1Disabled reads the single switch name", () => {
	process.env.HUMMIN_SYS1_GATE = "off";
	expect(sys1Disabled("HUMMIN_SYS1_GATE")).toBe(true);
	delete process.env.HUMMIN_SYS1_GATE;
	expect(sys1Disabled("HUMMIN_SYS1_GATE")).toBe(false);
	expect(sys1Disabled("HUMMIN_SYS1_STEER")).toBe(false);
});

// --- Settings layer ------------------------------------------------------------

test("settings decision.url and apiKey override the defaults", () => {
	const cwd = projectWithSettings({
		decision: { url: "http://nas:9993/v1/systemone", apiKey: "nas-key" },
	});
	const engine = resolveDecisionEngine(cwd);
	expect(engine.url).toBe("http://nas:9993/v1/systemone");
	expect(engine.apiKey).toBe("nas-key");
});

test("settings decision.gateThreshold overrides the default but not env", () => {
	const cwd = projectWithSettings({ decision: { gateThreshold: 0.6 } });
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.6);
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "0.9";
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.9);
});

test("an empty settings url marks the engine unconfigured with a warning", () => {
	const cwd = projectWithSettings({ decision: { url: "" } });
	expect(resolveDecisionEngine(cwd).unconfigured).toBe(true);
	expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
	// The second resolution does not repeat the warning.
	resolveDecisionEngine(cwd);
	expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
});

test("timeout overrides pass validation (minimum 1000ms)", () => {
	const cwd = projectWithSettings({
		decision: { gateTimeoutMs: 9000, decideTimeoutMs: 500, dispatchTimeoutMs: 3000 },
	});
	const engine = resolveDecisionEngine(cwd);
	expect(engine.gateTimeoutMs).toBe(9000);
	expect(engine.dispatchTimeoutMs).toBe(3000);
	// A value under one second is dropped rather than trusted.
	expect(engine.decideTimeoutMs).toBe(120000);
});

test("a malformed decision namespace is ignored, not fatal", () => {
	const cwd = projectWithSettings({ decision: "nope" });
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.75);
});

test("env beats stored settings, invalid env falls to stored", () => {
	const cwd = projectWithSettings({ decision: { gateThreshold: 0.8, steerThreshold: 0.6 } });
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "0.9";
	process.env.HUMMIN_DECISION_STEER_THRESHOLD = "nonsense";
	const engine = resolveDecisionEngine(cwd);
	expect(engine.gateThreshold).toBe(0.9);
	// invalid env falls through to the stored setting, not the default
	expect(engine.steerThreshold).toBe(0.6);
});

test("settings beats defaults project-over-global", () => {
	const dir = mkdtempSync(join(tmpdir(), "sys1-engine-project-"));
	createdDirs.push(dir);
	mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(dir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ decision: { gateThreshold: 0.6 } }));
	const agentDir = mkdtempSync(join(tmpdir(), "sys1-engine-agent-"));
	createdDirs.push(agentDir);
	mkdirSync(join(agentDir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(agentDir, CONFIG_DIR_NAME, "settings.json"),
		JSON.stringify({ decision: { gateThreshold: 0.7 } }),
	);
	const saved = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try {
		expect(resolveDecisionEngine(dir).gateThreshold).toBe(0.6);
	} finally {
		if (saved === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved;
	}
});

test("sys1Noul fails open for an unconfigured engine and parses a noul answer", async () => {
	const unconfigured = projectWithSettings({ decision: { url: "" } });
	const none = await sys1Noul(resolveDecisionEngine(unconfigured), "state", "q", "instructions");
	expect(none).toBeNull();

	const cwd = projectWithSettings({});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ answers: { q: { type: "noul", noul: 0.42 } } }),
		})),
	);
	const read = await sys1Noul(resolveDecisionEngine(cwd), "state", "q", "instructions");
	expect(read).toEqual({ noul: 0.42 });
});
