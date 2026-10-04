/**
 * lib/decision-engine: connection and calibration for hummin's System-1 layer.
 *
 * One System-1 engine answers every System-1 read: the bash gate's gray-zone
 * scoring, the per-turn destructive steer, test-failure triage, memory
 * intake, child-dispatch review, and the sys1_decide tool. Thresholds are
 * calibrated against that one engine's score distribution, so there is no
 * engine mixing and no auto-failover: an unreachable engine fails open per
 * read (the deterministic gate classifiers still run).
 *
 * Resolution order per field: HUMMIN_DECISION_* env > settings decision.* >
 * defaults. Settings are read guarded so extensions keep working against
 * runtime binaries whose SettingsManager predates the decision namespace.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface DecisionEngineConfig {
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
	/** True when the engine needs a url that is not configured. Automatic
	 * reads fail open; the tool reports a configure hint. */
	unconfigured: boolean;
}

/** Defaults calibrated against the production engine (2026-10-03 probe
 * matrix, PR #13): safe gate probes scored 0.016-0.03, unambiguous
 * destructive 0.85-0.97, and the gray zone splits at the line - git rebase
 * 0.84 and an unknown command touching /etc/passwd 0.86 block,
 * force-with-lease 0.69 passes. Steer is 0.8 because a benign rename prompt
 * scored 0.733. Gate timeout 8s: measured p95 ~6.5s under load. The
 * deterministic classifiers block every canonical destructive form before
 * the engine is consulted; the scored layer only ever judges the gray
 * zone. */
export const ENGINE_DEFAULTS: DecisionEngineConfig = {
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
};

/** Settings override shape for the decision namespace (mirrors the typed
 * namespace in settings-manager.ts; declared structurally so this module
 * works against runtime binaries whose SettingsManager predates it). */
interface DecisionSettingsShape {
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

function overrideFor(settings: DecisionSettingsShape | undefined): DecisionSettingsShape {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return {};
	const out: DecisionSettingsShape = {};
	for (const key of [
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
	] as const) {
		const value = (settings as Record<string, unknown>)[key];
		if (value !== undefined) out[key] = value;
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
			return isDecisionShape(value) ? overrideFor(value as DecisionSettingsShape) : undefined;
		}
		// Older runtimes whose SettingsManager predates the decision namespace:
		// merge the raw global and project settings (project wins per field).
		const readRaw = (name: string): DecisionSettingsShape | undefined => {
			const method = prototype[name];
			if (typeof method !== "function") return undefined;
			const raw = (method as () => unknown).call(settings) as { decision?: unknown };
			return isDecisionShape(raw?.decision) ? (raw.decision as DecisionSettingsShape) : undefined;
		};
		const globalValue = readRaw("getGlobalSettings");
		const projectValue = readRaw("getProjectSettings");
		if (globalValue === undefined && projectValue === undefined) return undefined;
		return { ...overrideFor(globalValue), ...overrideFor(projectValue) };
	} catch {
		return undefined;
	}
}

function isDecisionShape(value: unknown): value is object {
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

let warnedUnconfigured = false;

/** Resolve the engine's connection and calibration. Never throws. An empty
 * url keeps `unconfigured` true so callers can fail open with a configure
 * hint. */
export function resolveDecisionEngine(cwd: string = process.cwd()): DecisionEngineConfig {
	const override = overrideFor(readDecisionSettings(cwd));

	// env > settings override > defaults. An explicitly empty settings url
	// opts out (unconfigured, reads fail open). COLI_API_KEY is the legacy
	// shared credential for the local fleet; it applies because the default
	// engine is local. Hosted auth stays explicit: HUMMIN_DECISION_API_KEY or
	// decision.apiKey.
	const rawUrl = typeof override.url === "string" ? override.url.trim() : undefined;
	const url = envStr("HUMMIN_DECISION_URL") ?? rawUrl ?? ENGINE_DEFAULTS.url;
	const legacyFleetKey = envStr("COLI_API_KEY");
	const apiKey = envStr("HUMMIN_DECISION_API_KEY") ?? str(override.apiKey) ?? legacyFleetKey ?? ENGINE_DEFAULTS.apiKey;
	const gateThreshold =
		clamp01(envStr("HUMMIN_DECISION_GATE_THRESHOLD")) ?? clamp01(override.gateThreshold) ?? ENGINE_DEFAULTS.gateThreshold;
	const steerThreshold =
		clamp01(envStr("HUMMIN_DECISION_STEER_THRESHOLD")) ?? clamp01(override.steerThreshold) ?? ENGINE_DEFAULTS.steerThreshold;
	const triageThreshold =
		clamp01(envStr("HUMMIN_DECISION_TRIAGE_THRESHOLD")) ?? clamp01(override.triageThreshold) ?? ENGINE_DEFAULTS.triageThreshold;
	const intakeThreshold =
		clamp01(envStr("HUMMIN_DECISION_INTAKE_THRESHOLD")) ?? clamp01(override.intakeThreshold) ?? ENGINE_DEFAULTS.intakeThreshold;
	const gateTimeoutMs = clampMs(override.gateTimeoutMs) ?? ENGINE_DEFAULTS.gateTimeoutMs;
	const dispatchTimeoutMs = clampMs(override.dispatchTimeoutMs) ?? ENGINE_DEFAULTS.dispatchTimeoutMs;
	const decideTimeoutMs = clampMs(override.decideTimeoutMs) ?? ENGINE_DEFAULTS.decideTimeoutMs;
	const warmTimeoutMs = clampMs(override.warmTimeoutMs) ?? ENGINE_DEFAULTS.warmTimeoutMs;

	const unconfigured = url.trim() === "";
	if (unconfigured && !warnedUnconfigured) {
		warnedUnconfigured = true;
		console.error("[sys1] the decision engine has no url; set settings decision.url or env HUMMIN_DECISION_URL. System-1 reads fail open until configured.");
	}
	return {
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

/** Kill-switch helper: the named HUMMIN_* env switch disables a System-1
 * read when set to "off". */
export function sys1Disabled(name: string): boolean {
	return envStr(name)?.toLowerCase() === "off";
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

/** One-question noul read from the engine; null on any failure, timeout, or
 * unconfigured engine (fail open). The bearer header is omitted when no key
 * is configured, so no-auth engines work with zero configuration; an
 * auth-requiring server surfaces its 401 as a failed read. */
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
