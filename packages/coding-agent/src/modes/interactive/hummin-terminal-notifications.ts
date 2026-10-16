import type { TUI } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { sendTerminalNotification, setNotificationGate } from "../../core/terminal-notifications.ts";

type NotificationSettings = Pick<SettingsManager, "getTerminalNotifications" | "getTerminalNotificationsWhen">;

/**
 * One gate for every notification call site (core agent_end + hummin-ask): applies the notificationsWhen condition against the live terminal focus.
 */
export function installTerminalNotificationGate(
	settingsManager: NotificationSettings,
	ui: Pick<TUI, "terminal">,
): void {
	setNotificationGate(() => {
		if (settingsManager.getTerminalNotificationsWhen() === "always") return true;
		return ui.terminal.isFocused() !== true;
	});
}

export function notifyTurnComplete(settingsManager: NotificationSettings): void {
	const notifyChannel = settingsManager.getTerminalNotifications();
	if (notifyChannel !== "off") {
		sendTerminalNotification(notifyChannel, `${APP_NAME}: turn complete`);
	}
}
