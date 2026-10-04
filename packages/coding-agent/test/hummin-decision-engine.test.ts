import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DECISION_ENGINES, resolveDecisionEngine, sys1Disabled, sys1Noul } from "../extensions/lib/decision-engine.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";

// Engine resolution for the System-1 layer. Resolution order per field:
// HUMMIN_DECISION_* env > legacy HUMMIN_LAYA_* env and flat laya settings
// (engine=laya only) > settings decision.<engine>.* > engine defaults. Every
// test pins env and the agent dir explicitly: the module reads env at call
// time and settings through SettingsManager, so unpinned values would leak
// the developer's real environment into the assertions.

const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = [
	"HUMMIN_DECISION_ENGINE",
	"HUMMIN_DECISION_URL",
	"HUMMIN_DECISION_API_KEY",
	"HUMMIN_DECISION_GATE_THRESHOLD",
	"HUMMIN_DECISION_STEER_THRESHOLD",
	"HUMMIN_DECISION_TRIAGE_THRESHOLD",
	"HUMMIN_DECISION_INTAKE_THRESHOLD",
	"HUMMIN_SYS1_GATE",
	"HUMMIN_LAYA_URL",
	"HUMMIN_LAYA_GATE_THRESHOLD",
	"HUMMIN_LAYA_STEER_THRESHOLD",
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
 * the decision namespace (and legacy flat keys) through the real
 * SettingsManager loader against that project. The config dir name comes from
 * the package's piConfig (.hummin in this fork). */
function projectWithSettings(settings: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "sys1-engine-project-"));
	createdDirs.push(dir);
	mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(dir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(settings));
	return dir;
}

test("defaults resolve to the laya engine with its profile", () => {
	const engine = resolveDecisionEngine();
	expect(engine.id).toBe("laya");
	expect(engine.url).toBe("http://127.0.0.1:9989/v1/systemone");
	expect(engine.gateThreshold).toBe(0.75);
	expect(engine.steerThreshold).toBe(0.7);
	expect(engine.triageThreshold).toBe(0.45);
	expect(engine.gateTimeoutMs).toBe(4000);
	expect(engine.dispatchTimeoutMs).toBe(1500);
	expect(engine.decideTimeoutMs).toBe(15000);
	expect(engine.unconfigured).toBe(false);
});

test("HUMMIN_DECISION_ENGINE selects another engine with its own profile", () => {
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	const engine = resolveDecisionEngine();
	expect(engine.id).toBe("clef");
	expect(engine.url).toBe("http://127.0.0.1:9987/v1/systemone");
	expect(engine.gateTimeoutMs).toBe(8000);
	expect(engine.decideTimeoutMs).toBe(120000);
	// Clef's calibrated lines (2026-10-03 probe matrix, see
	// lib/decision-engine.ts): the gate line survives recalibration at 0.75,
	// steer moved up to keep a benign 0.733 prompt from firing, triage and
	// intake kept the laya lines.
	expect(engine.gateThreshold).toBe(0.75);
	expect(engine.steerThreshold).toBe(0.8);
	expect(engine.triageThreshold).toBe(0.45);
	expect(engine.intakeThreshold).toBe(0.5);
});

test("jev without a url resolves unconfigured and warns once", () => {
	process.env.HUMMIN_DECISION_ENGINE = "jev";
	expect(resolveDecisionEngine().unconfigured).toBe(true);
	expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
	// The second resolution does not repeat the warning.
	resolveDecisionEngine();
	expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
});

test("an invalid engine id falls back to laya with a warning", () => {
	process.env.HUMMIN_DECISION_ENGINE = "gpt";
	const engine = resolveDecisionEngine();
	expect(engine.id).toBe("laya");
	expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
});

test("HUMMIN_DECISION_URL and HUMMIN_DECISION_API_KEY override any engine", () => {
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	process.env.HUMMIN_DECISION_URL = "http://clef.fleet:9993/v1/systemone";
	process.env.HUMMIN_DECISION_API_KEY = "fleet-key";
	const engine = resolveDecisionEngine();
	expect(engine.url).toBe("http://clef.fleet:9993/v1/systemone");
	expect(engine.apiKey).toBe("fleet-key");
});

test("legacy laya envs steer only the laya engine", () => {
	process.env.HUMMIN_LAYA_URL = "http://laya.test/v1/systemone";
	expect(resolveDecisionEngine().url).toBe("http://laya.test/v1/systemone");
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	expect(resolveDecisionEngine().url).toBe("http://127.0.0.1:9987/v1/systemone");
});

test("legacy laya threshold envs apply to the laya engine only", () => {
	process.env.HUMMIN_LAYA_GATE_THRESHOLD = "0.6";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.6);
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.75);
});

test("HUMMIN_DECISION_* thresholds beat the legacy env and defaults", () => {
	process.env.HUMMIN_LAYA_GATE_THRESHOLD = "0.6";
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "0.8";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.8);
});

test("out-of-range env thresholds are ignored, not trusted", () => {
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "1.5";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.75);
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "not-a-number";
	expect(resolveDecisionEngine().gateThreshold).toBe(0.75);
});

test("COLI_API_KEY is the legacy fleet key for local engines, never for hosted jev", () => {
	process.env.COLI_API_KEY = "shared-key";
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	expect(resolveDecisionEngine().apiKey).toBe("shared-key");
	delete process.env.HUMMIN_DECISION_ENGINE;
	expect(resolveDecisionEngine().apiKey).toBe("shared-key");
	// A local fleet credential must not leak to a hosted endpoint.
	process.env.HUMMIN_DECISION_ENGINE = "jev";
	expect(resolveDecisionEngine().apiKey).toBe("");
	// Hosted auth stays explicit.
	process.env.HUMMIN_DECISION_API_KEY = "jev-key";
	expect(resolveDecisionEngine().apiKey).toBe("jev-key");
});

test("sys1Disabled honors the canonical name over the legacy alias", () => {
	process.env.HUMMIN_SYS1_GATE = "off";
	expect(sys1Disabled("HUMMIN_SYS1_GATE", "HUMMIN_LAYA_GATE")).toBe(true);
	delete process.env.HUMMIN_SYS1_GATE;
	process.env.HUMMIN_LAYA_GATE = "off";
	expect(sys1Disabled("HUMMIN_SYS1_GATE", "HUMMIN_LAYA_GATE")).toBe(true);
	delete process.env.HUMMIN_LAYA_GATE;
	expect(sys1Disabled("HUMMIN_SYS1_GATE", "HUMMIN_LAYA_GATE")).toBe(false);
});

// --- Settings layer ------------------------------------------------------------

test("settings decision.engine selects the engine", () => {
	const cwd = projectWithSettings({ decision: { engine: "clef" } });
	expect(resolveDecisionEngine(cwd).id).toBe("clef");
});

test("settings decision.<engine>.url and apiKey override the engine profile", () => {
	const cwd = projectWithSettings({
		decision: {
			engine: "clef",
			clef: { url: "http://nas:9993/v1/systemone", apiKey: "nas-key" },
		},
	});
	const engine = resolveDecisionEngine(cwd);
	expect(engine.url).toBe("http://nas:9993/v1/systemone");
	expect(engine.apiKey).toBe("nas-key");
});

test("settings decision.<engine>.gateThreshold overrides the default but not env", () => {
	const cwd = projectWithSettings({ decision: { clef: { gateThreshold: 0.6 } } });
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.6);
	process.env.HUMMIN_DECISION_GATE_THRESHOLD = "0.9";
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.9);
});

test("legacy flat layaGateThreshold settings steer the laya engine only", () => {
	const cwd = projectWithSettings({ layaGateThreshold: 0.55 });
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.55);
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	expect(resolveDecisionEngine(cwd).gateThreshold).toBe(0.75);
});

test("per-engine timeout overrides pass validation (minimum 1000ms)", () => {
	const cwd = projectWithSettings({
		decision: {
			engine: "clef",
			clef: { gateTimeoutMs: 9000, decideTimeoutMs: 500, dispatchTimeoutMs: 3000 },
		},
	});
	process.env.HUMMIN_DECISION_ENGINE = "clef";
	const engine = resolveDecisionEngine(cwd);
	expect(engine.gateTimeoutMs).toBe(9000);
	expect(engine.dispatchTimeoutMs).toBe(3000);
	// A value under one second is dropped rather than trusted.
	expect(engine.decideTimeoutMs).toBe(120000);
});

test("a malformed decision namespace is ignored, not fatal", () => {
	const cwd = projectWithSettings({ decision: "nope" });
	expect(resolveDecisionEngine(cwd).id).toBe("laya");
});

test("legacy flat settings keys: env beats stored, invalid env falls to stored", () => {
	const cwd = projectWithSettings({ layaGateThreshold: 0.8, layaSteerThreshold: 0.6 });
	process.env.HUMMIN_LAYA_GATE_THRESHOLD = "0.9";
	process.env.HUMMIN_LAYA_STEER_THRESHOLD = "nonsense";
	const engine = resolveDecisionEngine(cwd);
	expect(engine.gateThreshold).toBe(0.9);
	// invalid env falls through to the stored setting, not the default
	expect(engine.steerThreshold).toBe(0.6);
});

test("env beats settings for engine selection", () => {
	const cwd = projectWithSettings({ decision: { engine: "clef" } });
	process.env.HUMMIN_DECISION_ENGINE = "laya";
	expect(resolveDecisionEngine(cwd).id).toBe("laya");
});

test("sys1Noul fails open for an unconfigured engine and parses a noul answer", async () => {
	process.env.HUMMIN_DECISION_ENGINE = "jev";
	const none = await sys1Noul(resolveDecisionEngine(), "state", "q", "instructions");
	expect(none).toBeNull();

	process.env.HUMMIN_DECISION_ENGINE = "laya";
	process.env.HUMMIN_LAYA_URL = "http://laya.test/v1/systemone";
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ answers: { q: { type: "noul", noul: 0.42 } } }),
		})),
	);
	const read = await sys1Noul(resolveDecisionEngine(), "state", "q", "instructions");
	expect(read).toEqual({ noul: 0.42 });
});

test("all engine ids are valid selectors", () => {
	expect(DECISION_ENGINES).toEqual(["laya", "clef", "jev"]);
});
