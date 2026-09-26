/** hummin-telemetry: installs the pi-telemetry JSONL event sink for this
 * process so core emits (turn completed, compaction ran, auto-retry scheduled)
 * persist to disk. Records land in <agentDir>/telemetry/<id>.jsonl, one JSON
 * object per line (ts, kind, name, attributes), keyed by session id once
 * session_start fires and by process id before that, so print-mode children
 * are captured too. The sink is process-wide: with several sessions in one
 * process, the last session_start wins. Total size of the telemetry directory
 * is capped with oldest-file rotation (pi-telemetry package).
 *
 * Kill switch: HUMMIN_TELEMETRY=0 (env wins) or telemetryEnabled=false in
 * settings (project overrides global). Everything is fail-open: telemetry
 * must never break startup.
 */
import { join } from "node:path";
import {
	type ExtensionAPI,
	FileTelemetryEventSink,
	getAgentDir,
	SettingsManager,
	setTelemetryEventSink,
} from "@earendil-works/pi-coding-agent";

interface TelemetrySettings {
	telemetryEnabled?: unknown;
}

/**
 * Pure kill-switch decision: a set HUMMIN_TELEMETRY env beats settings and
 * only an explicit 0/false/off/no disables; otherwise telemetryEnabled=false
 * in settings disables. Default is on.
 */
export function telemetryInstallEnabled(env: string | undefined, setting: boolean | undefined): boolean {
	const raw = env?.trim().toLowerCase();
	if (raw) return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
	return setting !== false;
}

function telemetrySetting(settings: SettingsManager): boolean | undefined {
	try {
		const global = settings.getGlobalSettings() as TelemetrySettings;
		const project = settings.getProjectSettings() as TelemetrySettings;
		const value = { ...global, ...project }.telemetryEnabled;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

export default function humminTelemetry(pi: ExtensionAPI): void {
	const settings = SettingsManager.create(process.cwd());
	if (!telemetryInstallEnabled(process.env.HUMMIN_TELEMETRY, telemetrySetting(settings))) return;

	const telemetryDir = (): string =>
		process.env.HUMMIN_TELEMETRY_DIR?.trim() || join(getAgentDir(), "telemetry");
	const install = (id: string): void =>
		setTelemetryEventSink(new FileTelemetryEventSink({ directory: telemetryDir(), fileName: `${id}.jsonl` }));

	// Capture pre-session work immediately; session_start re-keys to the id.
	install(`pid-${process.pid}`);
	pi.on("session_start", (_event, ctx) => {
		install(ctx.sessionManager.getSessionId());
	});
}
