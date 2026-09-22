import { aliasZcodeEnv, DISPLAY_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/undici-runtime.ts";

export function setupCli(): void {
	process.title = DISPLAY_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.HUMMIN_CODING_AGENT = "true";
	process.env.AI_AGENT = "hummin";
	aliasZcodeEnv();
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
