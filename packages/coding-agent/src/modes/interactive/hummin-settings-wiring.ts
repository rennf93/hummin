import type { Container, TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { applyHttpProxySettings } from "../../core/http-dispatcher.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { parseNotificationChannel, parseNotificationWhen } from "../../core/terminal-notifications.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import type { HumminSettingsCallbacks, HumminSettingsConfig } from "./components/hummin-settings.ts";
import { UserMessageComponent } from "./components/user-message.ts";

/** Class internals the hummin settings callbacks act on, passed in explicitly by InteractiveMode. */
export interface HumminSettingsCallbackContext {
	// Lazy: both are getters on InteractiveMode and can change across session replacement.
	getSettingsManager: () => SettingsManager;
	getSession: () => AgentSession;
	ui: Pick<TUI, "requestRender">;
	footer: { invalidate(): void };
	chatContainer: Container;
	showStatus: (message: string) => void;
	updateEditorBorderColor: () => void;
	updateSelectorValue: (id: string, value: string) => void;
}

export function humminSettingsConfig(settingsManager: SettingsManager): HumminSettingsConfig {
	return {
		streamingSubmitMode: settingsManager.getStreamingSubmitMode(),
		messageTimestamps: settingsManager.getMessageTimestamps(),
		compactPrompt: settingsManager.getCompactPrompt(),
		terminalNotifications: settingsManager.getTerminalNotifications(),
		terminalNotificationsWhen: settingsManager.getTerminalNotificationsWhen(),
		providersShowAll: settingsManager.getProvidersShowAll(),
		retryEnabled: settingsManager.getRetryEnabled(),
		memoryEnabled: settingsManager.getMemoryEnabled(),
		memoryMode: settingsManager.getMemoryMode(),
		memoryVaultDir: settingsManager.getMemoryVaultDir(),
		memoryProvider: settingsManager.getMemoryProvider(),
		memoryModelId: settingsManager.getMemoryModelId(),
		localInstances: settingsManager.getLocalInstances(),
		fleetAutoStart: settingsManager.getFleetAutoStart(),
		rightSizeEnabled: settingsManager.getRightSizeEnabled(),
		rightSizeSwingThreshold: settingsManager.getRightSizeSwingThreshold(),
		rightSizeProfileCount: settingsManager.getRightSizeProfiles().length,
		rightSizeProfilesJson: JSON.stringify(settingsManager.getRightSizeProfiles()),
		editorMode: settingsManager.getEditorMode(),
		externalEditor: settingsManager.getExternalEditorCommand(),
		websocketConnectTimeoutMs: settingsManager.getWebSocketConnectTimeoutMs(),
		httpProxy: settingsManager.getHttpProxy() ?? "",
		shellPath: settingsManager.getShellPath() ?? "",
		shellCommandPrefix: settingsManager.getShellCommandPrefix() ?? "",
		npmCommand: settingsManager.getNpmCommand()?.join(" ") ?? "",
		enableAnalytics: settingsManager.getEnableAnalytics(),
	};
}

export function humminSettingsCallbacks(ctx: HumminSettingsCallbackContext): HumminSettingsCallbacks {
	return {
		onStreamingSubmitModeChange: (mode) => {
			ctx.getSettingsManager().setStreamingSubmitMode(mode);
		},
		onMessageTimestampsChange: (enabled) => {
			ctx.getSettingsManager().setMessageTimestamps(enabled);
			for (const child of ctx.chatContainer.children) {
				if (child instanceof UserMessageComponent || child instanceof CustomMessageComponent) {
					child.setShowTimestamp(enabled);
				}
			}
			ctx.ui.requestRender();
		},
		onCompactPromptChange: (enabled) => {
			ctx.getSettingsManager().setCompactPrompt(enabled);
			// Reapply to the active tool set so the change takes effect next turn.
			ctx.getSession().setActiveToolsByName(ctx.getSession().getActiveToolNames());
			ctx.showStatus(enabled ? "Compact prompt: on (next turn)" : "Compact prompt: off (next turn)");
		},
		onTerminalNotificationsChange: (channel) => {
			const parsed = parseNotificationChannel(channel);
			if (!parsed) {
				ctx.updateSelectorValue("terminal-notifications", ctx.getSettingsManager().getTerminalNotifications());
				return;
			}
			ctx.getSettingsManager().setTerminalNotifications(parsed);
		},
		onTerminalNotificationsWhenChange: (when) => {
			const parsed = parseNotificationWhen(when);
			if (!parsed) {
				ctx.updateSelectorValue(
					"terminal-notifications-when",
					ctx.getSettingsManager().getTerminalNotificationsWhen(),
				);
				return;
			}
			ctx.getSettingsManager().setTerminalNotificationsWhen(parsed);
		},
		onDefaultThinkingLevelChange: (level) => {
			ctx.getSession().setThinkingLevel(level, { persist: true });
			ctx.footer.invalidate();
			ctx.updateEditorBorderColor();
			ctx.showStatus(`Default thinking level: ${level}`);
		},
		onProvidersShowAllChange: (enabled) => {
			ctx.getSettingsManager().setProvidersShowAll(enabled);
		},
		onRetryEnabledChange: (enabled) => {
			ctx.getSettingsManager().setRetryEnabled(enabled);
		},
		onMemoryEnabledChange: (enabled) => {
			ctx.getSettingsManager().setMemoryEnabled(enabled);
		},
		onMemoryModeChange: (mode) => {
			ctx.getSettingsManager().setMemoryMode(mode);
		},
		onMemoryVaultDirChange: (dir) => {
			ctx.getSettingsManager().setMemoryVaultDir(dir);
		},
		onMemoryProviderChange: (provider) => {
			ctx.getSettingsManager().setMemoryProvider(provider);
		},
		onMemoryModelIdChange: (modelId) => {
			ctx.getSettingsManager().setMemoryModelId(modelId);
		},
		onLocalInstancesChange: (instances) => {
			ctx.getSettingsManager().setLocalInstances(instances);
		},
		onFleetAutoStartChange: (enabled) => {
			ctx.getSettingsManager().setFleetAutoStart(enabled);
		},
		onRightSizeEnabledChange: (enabled) => {
			ctx.getSettingsManager().setRightSizeEnabled(enabled);
		},
		onRightSizeSwingThresholdChange: (threshold) => {
			ctx.getSettingsManager().setRightSizeSwingThreshold(threshold);
		},
		onRightSizeProfilesChange: (profilesJson) => {
			try {
				ctx.getSettingsManager().setRightSizeProfiles(JSON.parse(profilesJson));
				ctx.showStatus(`Right-size profiles: ${ctx.getSettingsManager().getRightSizeProfiles().length} configured`);
			} catch (error) {
				ctx.showStatus(
					`Invalid right-size profiles (not saved): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		onEditorModeChange: (mode) => {
			ctx.getSettingsManager().setEditorMode(mode);
			ctx.showStatus(mode === "vim" ? "Editor mode: vim (new sessions)" : "Editor mode: default (new sessions)");
		},
		onExternalEditorChange: (command) => {
			ctx.getSettingsManager().setExternalEditor(command);
		},
		onWebSocketConnectTimeoutMsChange: (timeoutMs) => {
			ctx.getSettingsManager().setWebSocketConnectTimeoutMs(timeoutMs);
		},
		onHttpProxyChange: (proxy) => {
			ctx.getSettingsManager().setHttpProxy(proxy);
			applyHttpProxySettings(proxy);
		},
		onShellPathChange: (path) => {
			ctx.getSettingsManager().setShellPath(path);
		},
		onShellCommandPrefixChange: (prefix) => {
			ctx.getSettingsManager().setShellCommandPrefix(prefix);
		},
		onNpmCommandChange: (command) => {
			ctx.getSettingsManager().setNpmCommand(command.length > 0 ? command : undefined);
		},
		onEnableAnalyticsChange: (enabled) => {
			ctx.getSettingsManager().setEnableAnalytics(enabled);
		},
	};
}
