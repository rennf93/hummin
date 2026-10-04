/**
 * lib/decision-engine: engine selection for hummin's System-1 layer.
 *
 * Exactly one engine answers every System-1 read at a time: the bash gate's
 * gray-zone scoring, the per-turn destructive steer, test-failure triage,
 * memory intake, child-dispatch review, and the sys1_decide tool. Engines:
 *
 * - laya: the cheap local choice (421M, port 9989), the long-standing default.
 * - clef: the middle ground, still local (9B, port 9987 Mac MLX / GGUF on the
 *   fleet), stronger and context-hungry (16k tokens).
 * - jev: the official strong choice, hosted, opt-in (url must be configured).
 *
 * One at a time is a deliberate contract, not a limitation: thresholds are
 * calibrated per engine, so mixing engines across read kinds would interleave
 * two score distributions in sys1-gate.log and split every calibration signal.
 * There is no auto-failover for the same reason: an unreachable engine fails
 * open per read (the deterministic gate classifiers still run), and the
 * menubar shows the dead service.
 *
 * Resolution order per field: HUMMIN_DECISION_* env (engine-agnostic) >
 * legacy HUMMIN_LAYA_* env and flat laya settings (engine=laya only) >
 * settings decision.<engine>.* > engine defaults. Settings are read guarded so
 * extensions keep working against runtime binaries whose SettingsManager
 * predates the decision namespace.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type DecisionEngineId = "laya" | "clef" | "jev";

export const DECISION_ENGINES: readonly DecisionEngineId[] = ["laya", "clef", "jev"];

/** Per-engine defaults. Thresholds are calibrated per engine. Clef's values
 * were recalibrated 2026-10-03 against the production rubric on the Mac MLX
 * instance (53-probe matrix; results in PR #13): safe gate probes scored
 * 0.016-0.03, unambiguous destructive 0.85-0.97, and the gray zone splits at
 * the line - git rebase 0.84 and an unknown command touching /etc/passwd 0.86
 * block, force-with-lease 0.69 passes. Steer moved 0.7 -> 0.8 because a
 * benign rename prompt scored 0.733; triage (0.90 vs 0.055) and intake
 * (0.86 vs 0.26) kept the laya lines. Gate timeout 8s: measured p95 ~6.5s
 * under load. Note the deterministic classifiers block every canonical
 * destructive form before the engine is consulted; the scored layer only
 * ever judges the gray zone. */
const ENGINE_DEFAULTS: Record<DecisionEngineId, DecisionEngineConfig> = {
	laya: {
		id: "laya",
		url: "http://127.0.0.1:9989/v1/systemone",
		apiKey: "",
		gateThreshold: 0.75,
		steerThreshold: 0.7,
		triageThreshold: 0.45,
		intakeThreshold: 0.5,
		gateTimeoutMs: 4000,
		dispatchTimeoutMs: 1500,
		decideTimeoutMs: 15000,
		warmTimeoutMs: 45000,
		unconfigured: false,
	},
	clef: {
		id: "clef",
		url: "http://127.0.0.1:9987/v1/systemone",
		apiKey: "",
		gateThreshold: 0.75,
		steerThreshold: 0.8,
		triageThreshold: 0.45,
		intakeThreshold: 0.5,
		gateTimeoutMs: 8000,
		dispatchTimeoutMs: 6000,
		decideTimeoutMs: 120000,
		warmTimeoutMs: 45000,
		unconfigured: false,
	},
	jev: {
		id: "jev",
		// Hosted: the endpoint is user-held (no guessed default), so selecting
		// jev without decision.jev.url fails open with a configure hint.
		url: "",
		apiKey: "",
		gateThreshold: 0.75,
		steerThreshold: 0.7,
		triageThreshold: 0.45,
		intakeThreshold: 0.5,
		gateTimeoutMs: 10000,
		dispatchTimeoutMs: 4000,
		decideTimeoutMs: 30000,
		warmTimeoutMs: 30000,
		unconfigured: true,
	},
};

/** The resolved connection and calibration for one engine snapshot. Callers
 * resolve once per hook invocation so /settings and env edits apply without a
 * restart while a single read stays internally consistent. */
export interface DecisionEngineConfig {
	id: DecisionEngineId;
	url: string;
	apiKey: string;
	gateThreshold: number;
	steerThreshold: number;
	triageThreshold: number;
	intakeThreshold: number;
	gateTimeoutMs: number;
	dispatchTimeoutMs: number;
	decideTimeoutMs: number;
	warmTimeoutMs: number;
	/** True when the engine needs a url that is not configured (jev by
	 * default). Automatic reads fail open; the tool reports a configure hint. */
	unconfigured: boolean;
}

/** Per-engine override shape from settings (mirrors the typed namespace in
 * settings-manager.ts; declared structurally so this module works against
 * runtime binaries whose SettingsManager predates the namespace). */
interface EngineOverrideShape {
	url?: unknown;
	apiKey?: unknown;
	gateThreshold?: unknown;
	steerThreshold?: unknown;
	triageThreshold?: unknown;
	intakeThreshold?: unknown;
	gateTimeoutMs?: unknown;
	dispatchTimeoutMs?: unknown;
	decideTimeoutMs?: unknown;
	warmTimeoutMs?: unknown;
}

interface DecisionSettingsShape {
	engine?: unknown;
	laya?: unknown;
	clef?: unknown;
	jev?: unknown;
}

const ENGINE_OVERRIDE_KEYS = [
	"url",
	"apiKey",
	"gateThreshold",
	"steerThreshold",
	"triageThreshold",
	"intakeThreshold",
	"gateTimeoutMs",
	"dispatchTimeoutMs",
	"decideTimeoutMs",
	"warmTimeoutMs",
] as const;

function overrideFor(settings: DecisionSettingsShape | undefined, id: DecisionEngineId): EngineOverrideShape {
	const raw: unknown = settings?.[id];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const out: EngineOverrideShape = {};
	const record = raw as Record<string, unknown>;
	for (const key of ENGINE_OVERRIDE_KEYS) {
		if (record[key] !== undefined) out[key] = record[key];
	}
	return out;
}

function readDecisionSettings(cwd: string): DecisionSettingsShape | undefined {
	try {
		const settings = SettingsManager.create(cwd);
		const prototype = settings as unknown as Record<string, unknown>;
		const accessor = prototype.getDecisionEngineSettings;
		if (typeof accessor === "function") {
			const value = (accessor as () => unknown).call(settings) as unknown;
			return isDecisionShape(value) ? value : undefined;
		}
		// Older runtimes whose SettingsManager predates the decision namespace:
		// merge the raw global and project settings (project wins) with a merge
		// scoped to the namespace's two-level shape so per-engine overrides
		// combine field-by-field instead of the project object clobbering the
		// global one wholesale.
		const readRaw = (name: string): DecisionSettingsShape | undefined => {
			const method = prototype[name];
			if (typeof method !== "function") return undefined;
			const raw = (method as () => unknown).call(settings) as { decision?: unknown };
			return isDecisionShape(raw?.decision) ? (raw.decision as DecisionSettingsShape) : undefined;
		};
		const globalValue = readRaw("getGlobalSettings");
		const projectValue = readRaw("getProjectSettings");
		if (globalValue === undefined && projectValue === undefined) return undefined;
		const merged: DecisionSettingsShape = { ...globalValue };
		const engineOf = (value: DecisionSettingsShape | undefined) =>
			value !== undefined && (typeof value.engine === "string" || typeof value.engine === "number")
				? String(value.engine)
				: undefined;
		if (projectValue !== undefined && engineOf(projectValue) !== undefined) merged.engine = projectValue.engine;
		for (const id of DECISION_ENGINES) {
			const g = overrideFor(globalValue, id);
			const p = overrideFor(projectValue, id);
			if (Object.keys(g).length === 0 && Object.keys(p).length === 0) continue;
			merged[id] = { ...g, ...p };
		}
		return merged;
	} catch {
		return undefined;
	}
}

function isDecisionShape(value: unknown): value is DecisionSettingsShape {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const clamp01 = (value: unknown): number | undefined => {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
};

const clampMs = (value: unknown): number | undefined => {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 1000 ? Math.round(n) : undefined;
};

const envStr = (name: string): string | undefined => {
	const raw = process.env[name]?.trim();
	return raw !== undefined && raw !== "" ? raw : undefined;
};

let warnedInvalidEngine = false;
let warnedUnconfigured = false;

function warnOnce(key: "invalidEngine" | "unconfigured", message: string): void {
	if (key === "invalidEngine") {
		if (warnedInvalidEngine) return;
		warnedInvalidEngine = true;
	} else {
		if (warnedUnconfigured) return;
		warnedUnconfigured = true;
	}
	console.error(`[sys1] ${message}`);
}

/** Resolve the active engine's connection and calibration. Never throws.
 * An invalid engine id falls back to laya (warned once, naming the source);
 * an unconfigured jev keeps its empty url so callers can fail open with a
 * configure hint. */
export function resolveDecisionEngine(cwd: string = process.cwd()): DecisionEngineConfig {
	const settings = readDecisionSettings(cwd);
	const storedEngine = settings?.engine !== undefined && settings.engine !== null ? String(settings.engine).trim() : undefined;
	const envEngine = envStr("HUMMIN_DECISION_ENGINE");
	const rawEngine = envEngine ?? storedEngine;
	let id: DecisionEngineId = "laya";
	if (rawEngine !== undefined && rawEngine !== "") {
		if ((DECISION_ENGINES as readonly string[]).includes(rawEngine)) {
			id = rawEngine as DecisionEngineId;
		} else {
			const source = envEngine !== undefined ? "env HUMMIN_DECISION_ENGINE" : "settings decision.engine";
			warnOnce("invalidEngine", `${source}='${rawEngine}' is not one of ${DECISION_ENGINES.join("|")}; using laya.`);
		}
	}
	const base = ENGINE_DEFAULTS[id];
	const override = overrideFor(settings, id);
	const legacy = id === "laya" ? readLegacyLayaOverrides(cwd) : {};

	// env > settings override > legacy (laya only) > engine defaults. The
	// legacy HUMMIN_LAYA_URL names the laya engine specifically, so it must
	// not leak into clef/jev URL resolution.
	const url = envStr("HUMMIN_DECISION_URL") ?? (id === "laya" ? envStr("HUMMIN_LAYA_URL") : undefined) ?? str(override.url) ?? base.url;
	// COLI_API_KEY is the legacy shared credential for the LOCAL fleet engines
	// (laya/clef). It must never be sent to a hosted endpoint: selecting jev
	// would otherwise attach a local fleet secret to every remote read. Hosted
	// auth is explicit: HUMMIN_DECISION_API_KEY or decision.jev.apiKey.
	const legacyFleetKey = id === "jev" ? undefined : envStr("COLI_API_KEY");
	const apiKey = envStr("HUMMIN_DECISION_API_KEY") ?? str(override.apiKey) ?? legacyFleetKey ?? base.apiKey;
	const gateThreshold = clamp01(envStr("HUMMIN_DECISION_GATE_THRESHOLD")) ?? legacy.gateThreshold ?? clamp01(override.gateThreshold) ?? base.gateThreshold;
	const steerThreshold = clamp01(envStr("HUMMIN_DECISION_STEER_THRESHOLD")) ?? legacy.steerThreshold ?? clamp01(override.steerThreshold) ?? base.steerThreshold;
	const triageThreshold = clamp01(envStr("HUMMIN_DECISION_TRIAGE_THRESHOLD")) ?? clamp01(override.triageThreshold) ?? base.triageThreshold;
	const intakeThreshold = clamp01(envStr("HUMMIN_DECISION_INTAKE_THRESHOLD")) ?? clamp01(override.intakeThreshold) ?? base.intakeThreshold;
	const gateTimeoutMs = clampMs(override.gateTimeoutMs) ?? base.gateTimeoutMs;
	const dispatchTimeoutMs = clampMs(override.dispatchTimeoutMs) ?? base.dispatchTimeoutMs;
	const decideTimeoutMs = clampMs(override.decideTimeoutMs) ?? base.decideTimeoutMs;
	const warmTimeoutMs = clampMs(override.warmTimeoutMs) ?? base.warmTimeoutMs;

	const unconfigured = url.trim() === "";
	if (unconfigured) {
		warnOnce("unconfigured", `decision engine '${id}' has no url; set settings decision.${id}.url or env HUMMIN_DECISION_URL. System-1 reads fail open until configured.`);
	}
	return {
		id,
		url,
		apiKey,
		gateThreshold,
		steerThreshold,
		triageThreshold,
		intakeThreshold,
		gateTimeoutMs,
		dispatchTimeoutMs,
		decideTimeoutMs,
		warmTimeoutMs,
		unconfigured,
	};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Legacy laya threshold resolution: the pre-decision flat settings keys
 * (`layaGateThreshold` / `layaSteerThreshold`) still steer the laya engine so
 * existing settings files keep working. Env wins (checked here first); the
 * raw global+project values are merged project-wins, matching the flat-key
 * precedence the removed accessors implemented. */
function readLegacyLayaOverrides(cwd: string): { gateThreshold?: number; steerThreshold?: number } {
	const gateEnv = clamp01(envStr("HUMMIN_LAYA_GATE_THRESHOLD"));
	const steerEnv = clamp01(envStr("HUMMIN_LAYA_STEER_THRESHOLD"));
	if (gateEnv !== undefined && steerEnv !== undefined) return { gateThreshold: gateEnv, steerThreshold: steerEnv };
	try {
		const settings = SettingsManager.create(cwd) as unknown as Record<string, unknown>;
		const readFlat = (method: string): { layaGateThreshold?: unknown; layaSteerThreshold?: unknown } => {
			const fn = settings[method];
			if (typeof fn !== "function") return {};
			return (fn as () => { layaGateThreshold?: unknown; layaSteerThreshold?: unknown }).call(settings) ?? {};
		};
		const merged = { ...readFlat("getGlobalSettings"), ...readFlat("getProjectSettings") };
		return {
			gateThreshold: gateEnv ?? clamp01(merged.layaGateThreshold),
			steerThreshold: steerEnv ?? clamp01(merged.layaSteerThreshold),
		};
	} catch {
		return { gateThreshold: gateEnv, steerThreshold: steerEnv };
	}
}

/** Kill-switch helper: the HUMMIN_SYS1_* names are canonical, the HUMMIN_LAYA_*
 * names stay as honored aliases (they are safety controls; ignoring an
 * existing HUMMIN_LAYA_GATE=off on rename would silently re-enable a gate the
 * user turned off). */
export function sys1Disabled(canonical: string, legacy: string): boolean {
	return envStr(canonical) !== undefined
		? envStr(canonical)?.toLowerCase() === "off"
		: envStr(legacy)?.toLowerCase() === "off";
}

/** POST one SystemOne request with the engine's bearer auth (omitted when no
 * key is configured) and a per-attempt timeout. Retries once on
 * abort/timeout/connection-reset (the cold-start checkpoint load) so a
 * just-started server does not fail the very first call; any other error is
 * rethrown for the caller to handle. */
export async function sys1Fetch(config: DecisionEngineConfig, body: string, timeoutMs: number): Promise<Response> {
	const common = {
		method: "POST" as const,
		headers: {
			"Content-Type": "application/json",
			...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
		},
		body,
	};
	try {
		return await fetch(config.url, { ...common, signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		if (err instanceof Error && /abort|timeout|econnreset|eclosed|eai_again|enotfound|econnrefused/i.test(err.message)) {
			return await fetch(config.url, { ...common, signal: AbortSignal.timeout(timeoutMs) });
		}
		throw err;
	}
}

/** One-question noul read from the active engine; null on any failure,
 * timeout, or unconfigured engine (fail open). The bearer header is omitted
 * when no key is configured, so no-auth engines (the Mac MLX instance) work
 * with zero configuration; an auth-requiring server surfaces its 401 as a
 * failed read. */
export async function sys1Noul(config: DecisionEngineConfig, state: string, name: string, instructions: string, timeoutMs: number = config.gateTimeoutMs): Promise<{ noul: number } | null> {
	if (config.unconfigured) return null;
	try {
		const response = await sys1Fetch(config, JSON.stringify({ state, questions: { [name]: { type: "noul", instructions } } }), timeoutMs);
		if (!response.ok) return null;
		const payload = (await response.json()) as { answers?: Record<string, { noul?: number }> };
		const answer = payload.answers?.[name];
		return typeof answer?.noul === "number" ? { noul: answer.noul } : null;
	} catch {
		return null;
	}
}
