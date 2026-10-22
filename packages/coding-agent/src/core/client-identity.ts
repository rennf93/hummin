import type { ClientAttribution, ClientIdentity } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/** hummin's provider attribution: who recipients should see as the requesting agent. */
const HUMMIN_ATTRIBUTION: ClientAttribution = {
	name: "hummin",
	url: "https://github.com/rennf93/hummin",
	categories: ["cli-agent"],
};

/**
 * How hummin's requests identify it to providers: a detailed `User-Agent` with hummin's version, and attribution to
 * hummin as a CLI agent while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager) ? HUMMIN_ATTRIBUTION : null,
	};
}
