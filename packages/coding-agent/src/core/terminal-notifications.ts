/**
 * Terminal-level notifications for attention events (turn finished, agent asked
 * a question). Written directly to stdout as escape sequences so the terminal
 * emulator - not the TUI - renders them:
 *
 * - BEL (`\x07`): marks the tab/pane (Warp dot, tmux bell) and may ring a sound.
 * - OSC 9 (`\x1b]9;<message>\x07`): iTerm2/Windows Terminal/ConEmu toast from
 *   the message payload.
 * - desktop: a real OS notification via the platform backend (osascript on
 *   macOS, notify-send on Linux), detected once per process.
 *
 * The OSC message must not contain ESC or BEL, so it is sanitized before
 * emission; those bytes would otherwise terminate or corrupt the sequence.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type TerminalNotificationChannel = "off" | "bell" | "osc9" | "desktop" | "all";

export const NOTIFICATION_CHANNELS: readonly TerminalNotificationChannel[] = ["off", "bell", "osc9", "desktop", "all"];

export const DEFAULT_NOTIFICATION_CHANNEL: TerminalNotificationChannel = "bell";

/** When notifications fire: on every event, or only when the terminal is not focused. */
export type TerminalNotificationWhen = "always" | "unfocused";

export const NOTIFICATION_WHEN_VALUES: readonly TerminalNotificationWhen[] = ["always", "unfocused"];

export const DEFAULT_NOTIFICATION_WHEN: TerminalNotificationWhen = "unfocused";

const OSC9_MESSAGE_MAX = 200;

/** Keep a value only if it names a known channel (case-insensitive). */
export function parseNotificationChannel(raw: unknown): TerminalNotificationChannel | undefined {
	if (typeof raw !== "string") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return undefined;
	return (NOTIFICATION_CHANNELS as readonly string[]).includes(normalized)
		? (normalized as TerminalNotificationChannel)
		: undefined;
}

/** Keep a value only if it names a known when-condition (case-insensitive). */
export function parseNotificationWhen(raw: unknown): TerminalNotificationWhen | undefined {
	if (typeof raw !== "string") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return undefined;
	return (NOTIFICATION_WHEN_VALUES as readonly string[]).includes(normalized)
		? (normalized as TerminalNotificationWhen)
		: undefined;
}

/**
 * Env wins over the stored setting; anything invalid falls through to the next
 * source and finally to the default. Mirrors the resolveLayaThreshold pattern.
 */
export function resolveNotificationChannel(env: unknown, setting: unknown): TerminalNotificationChannel {
	return parseNotificationChannel(env) ?? parseNotificationChannel(setting) ?? DEFAULT_NOTIFICATION_CHANNEL;
}

/** Same precedence for the when-condition. */
export function resolveNotificationWhen(env: unknown, setting: unknown): TerminalNotificationWhen {
	return parseNotificationWhen(env) ?? parseNotificationWhen(setting) ?? DEFAULT_NOTIFICATION_WHEN;
}

/** Strip bytes that would terminate the OSC sequence, then bound the length. */
export function sanitizeNotificationMessage(raw: string): string {
	const clean = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return clean.length > OSC9_MESSAGE_MAX ? `${clean.slice(0, OSC9_MESSAGE_MAX - 1)}…` : clean;
}

export type NotificationWriter = (data: string) => void;

/** Minimal shape of the child_process.spawn function, injectable for tests. */
export type NotificationSpawner = (
	command: string,
	args: string[],
) => { unref(): void; on(event: "error", listener: () => void): unknown };

interface DesktopBackend {
	/** Absolute binary path to spawn. */
	binary: string;
	argv: (title: string, message: string) => string[];
}

const DESKTOP_BACKENDS: Record<
	string,
	{ binary: string; pathLookup: boolean; argv: (title: string, message: string) => string[] } | undefined
> = {
	darwin: {
		binary: "/usr/bin/osascript",
		pathLookup: false,
		argv: (title, message) => ["-e", `display notification "${message}" with title "${title}"`],
	},
	linux: { binary: "notify-send", pathLookup: true, argv: (title, message) => [title, message] },
};

let cachedDesktopBackend: DesktopBackend | undefined | null;

/** Resolve the platform notification backend, or undefined when none exists. Cached per process. */
export function detectDesktopBackend(
	platform: NodeJS.Platform = process.platform,
	pathEnv: string = process.env.PATH ?? "",
): DesktopBackend | undefined {
	if (cachedDesktopBackend !== null) return cachedDesktopBackend ?? undefined;
	cachedDesktopBackend = undefined;
	const spec = DESKTOP_BACKENDS[platform];
	if (!spec) return undefined;
	if (spec.pathLookup) {
		const found = pathEnv.split(":").some((dir) => dir && existsSync(`${dir}/${spec.binary}`));
		if (!found) return undefined;
	} else if (!existsSync(spec.binary)) {
		return undefined;
	}
	cachedDesktopBackend = { binary: spec.binary, argv: spec.argv };
	return cachedDesktopBackend;
}

/** Test seam: reset the cached desktop backend detection. */
export function resetDesktopBackendCache(): void {
	cachedDesktopBackend = null;
}

/**
 * Gate consulted before every emission. interactive-mode registers one that
 * applies the `notificationsWhen` condition (always vs unfocused-only) against
 * the live terminal focus state, so core and extension call sites share it.
 * Return false to suppress the notification entirely.
 */
let notificationGate: (() => boolean) | undefined;

export function setNotificationGate(gate: (() => boolean) | undefined): void {
	notificationGate = gate;
}

export interface NotificationSentEvent {
	message: string;
	channel: TerminalNotificationChannel;
}

type NotificationListener = (event: NotificationSentEvent) => void;

const notificationListeners = new Set<NotificationListener>();

/** Subscribe to emission attempts (sent or gate-suppressed); extension hooks
 * surface these as `notification` events and JSON mode as event lines. */
export function onNotificationSent(listener: NotificationListener): () => void {
	notificationListeners.add(listener);
	return () => notificationListeners.delete(listener);
}

function emitNotificationSent(event: NotificationSentEvent): void {
	for (const listener of notificationListeners) {
		try {
			listener(event);
		} catch {
			// Listener errors must not break the notification path.
		}
	}
}

function spawnDesktopNotification(
	message: string,
	spawnFn: NotificationSpawner,
	detect: () => DesktopBackend | undefined,
): void {
	const backend = detect();
	if (!backend) return;
	const title = "hummin";
	// Only quotes need escaping inside the AppleScript string literal.
	const safe = message.replaceAll('"', '\\"');
	try {
		const child = spawnFn(backend.binary, backend.argv(title, safe));
		child.on("error", () => {});
		child.unref();
	} catch {
		// Desktop notifications are best-effort; never surface failures.
	}
}

/**
 * Emit a notification on the given channel. `writer` and `spawnFn` are
 * injectable for tests; production writes to stdout (the terminal in TUI mode)
 * and spawns the desktop backend detached. Returns true when anything was
 * written or spawned. The notification gate (notificationsWhen + focus state)
 * can suppress the whole call.
 */
export function sendTerminalNotification(
	channel: TerminalNotificationChannel,
	message: string,
	writer: NotificationWriter = (data) => process.stdout.write(data),
	spawnFn: NotificationSpawner = spawn as unknown as NotificationSpawner,
	detect: () => DesktopBackend | undefined = detectDesktopBackend,
): boolean {
	if (channel === "off") return false;
	const sanitized = sanitizeNotificationMessage(message);
	// Subscribers (hooks, JSON event streams) see every non-off emission
	// attempt, including ones the notification gate suppresses: automation
	// wants the event; only the terminal output is conditional.
	emitNotificationSent({ message: sanitized, channel });
	if (notificationGate && !notificationGate()) return false;
	if (channel === "bell" || channel === "all") writer("\x07");
	if (channel === "osc9" || channel === "all") writer(`\x1b]9;${sanitized}\x07`);
	if (channel === "desktop" || channel === "all") spawnDesktopNotification(sanitized, spawnFn, detect);
	return true;
}
