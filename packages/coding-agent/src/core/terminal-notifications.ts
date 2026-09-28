/**
 * Terminal-level notifications for attention events (turn finished, agent asked
 * a question). Written directly to stdout as escape sequences so the terminal
 * emulator - not the TUI - renders them:
 *
 * - BEL (`\x07`): marks the tab/pane (Warp dot, tmux bell) and may ring a sound.
 * - OSC 9 (`\x1b]9;<message>\x07`): iTerm2/Windows Terminal/ConEmu toast from
 *   the message payload.
 *
 * The message must not contain ESC or BEL, so it is sanitized before emission;
 * those bytes would otherwise terminate or corrupt the sequence.
 */

export type TerminalNotificationChannel = "off" | "bell" | "osc9" | "all";

export const NOTIFICATION_CHANNELS: readonly TerminalNotificationChannel[] = ["off", "bell", "osc9", "all"];

export const DEFAULT_NOTIFICATION_CHANNEL: TerminalNotificationChannel = "bell";

const OSC9_MESSAGE_MAX = 200;

/** Keep a message only if it names a known channel (case-insensitive). */
export function parseNotificationChannel(raw: unknown): TerminalNotificationChannel | undefined {
	if (typeof raw !== "string") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return undefined;
	return (NOTIFICATION_CHANNELS as readonly string[]).includes(normalized)
		? (normalized as TerminalNotificationChannel)
		: undefined;
}

/**
 * Env wins over the stored setting; anything invalid falls through to the next
 * source and finally to the default. Mirrors the resolveLayaThreshold pattern.
 */
export function resolveNotificationChannel(env: unknown, setting: unknown): TerminalNotificationChannel {
	return parseNotificationChannel(env) ?? parseNotificationChannel(setting) ?? DEFAULT_NOTIFICATION_CHANNEL;
}

/** Strip bytes that would terminate the OSC sequence, then bound the length. */
export function sanitizeNotificationMessage(raw: string): string {
	const clean = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return clean.length > OSC9_MESSAGE_MAX ? `${clean.slice(0, OSC9_MESSAGE_MAX - 1)}…` : clean;
}

export type NotificationWriter = (data: string) => void;

/**
 * Emit a notification on the given channel. `writer` is injectable for tests;
 * production writes to stdout, which is the terminal in TUI mode. Returns true
 * when anything was written.
 */
export function sendTerminalNotification(
	channel: TerminalNotificationChannel,
	message: string,
	writer: NotificationWriter = (data) => process.stdout.write(data),
): boolean {
	if (channel === "off") return false;
	if (channel === "bell" || channel === "all") writer("\x07");
	if (channel === "osc9" || channel === "all") writer(`\x1b]9;${sanitizeNotificationMessage(message)}\x07`);
	return true;
}
