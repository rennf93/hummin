/**
 * Warp CLI-agent protocol transport (OSC 777).
 *
 * When Warp hosts a CLI agent it sets WARP_CLI_AGENT_PROTOCOL_VERSION=1 in the
 * PTY environment (also on Warpified SSH remotes). The agent then emits
 * `\x1b]777;notify;warp://cli-agent;{json}\x07` envelopes and Warp resolves the
 * `agent` field against its CLIAgent registry to drive tab badges and
 * notification-inbox entries. Envelope keys and event names follow Warp's
 * observed contract (warpdotdev/warp#15666, #13935); unknown agent names are
 * dropped by Warp until registered, which is why `agent` is "hummin" and not
 * piggybacked on another entry.
 */

import {
	isTerminalNotificationSuppressed,
	type NotificationWriter,
	sanitizeOscText,
} from "./terminal-notifications.ts";

export const WARP_CLI_AGENT_PROTOCOL_VERSION = 1;

const WARP_CLI_AGENT_SENTINEL = "warp://cli-agent";

/** Per-string payload cap; large enough for a response summary, small enough to stay line-oriented. */
const WARP_TEXT_FIELD_MAX = 2000;

export type WarpCliAgentEventName = "session_start" | "prompt_submit" | "stop" | "stop_failure" | "attention";

export interface WarpCliAgentEvent {
	readonly event: WarpCliAgentEventName;
	readonly sessionId: string;
	readonly cwd: string;
	/** Prompt text for prompt_submit, or the prompt that produced a stop. */
	readonly query?: string;
	/** Final assistant text for stop. */
	readonly response?: string;
	/** Blocking UI prompt kind for attention (select/confirm/input/editor/custom). */
	readonly kind?: string;
	/** Blocking UI prompt title for attention. */
	readonly title?: string;
}

/** True when the hosting terminal negotiated the CLI-agent protocol. */
export function isWarpCliAgentActive(env: NodeJS.ProcessEnv = process.env): boolean {
	const version = Number(env.WARP_CLI_AGENT_PROTOCOL_VERSION);
	return Number.isFinite(version) && version >= WARP_CLI_AGENT_PROTOCOL_VERSION;
}

/**
 * Serialize an event into the OSC 777 byte sequence. Free-text fields are
 * sanitized at this single chokepoint so ESC/BEL can never enter the envelope,
 * and the sequence is wrapped for tmux passthrough when running inside tmux
 * (with allow-passthrough off, tmux drops the wrap silently and harmlessly).
 */
export function buildWarpCliAgentSequence(event: WarpCliAgentEvent, env: NodeJS.ProcessEnv = process.env): string {
	const payload = JSON.stringify({
		v: WARP_CLI_AGENT_PROTOCOL_VERSION,
		agent: "hummin",
		event: event.event,
		...(event.sessionId ? { session_id: event.sessionId } : {}),
		cwd: event.cwd,
		...(event.query !== undefined ? { query: sanitizeOscText(event.query, WARP_TEXT_FIELD_MAX) } : {}),
		...(event.response !== undefined ? { response: sanitizeOscText(event.response, WARP_TEXT_FIELD_MAX) } : {}),
		...(event.kind !== undefined ? { kind: event.kind } : {}),
		...(event.title !== undefined ? { title: sanitizeOscText(event.title, WARP_TEXT_FIELD_MAX) } : {}),
	});
	const sequence = `\x1b]777;notify;${WARP_CLI_AGENT_SENTINEL};${payload}\x07`;
	return env.TMUX !== undefined ? wrapTmuxPassthrough(sequence) : sequence;
}

/** Wrap an escape sequence so tmux forwards it to the outer terminal (ESC doubled inside the DCS wrapper). */
function wrapTmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Emit an event to the TTY. Suppressed wherever notification emission is
 * suppressed (print/RPC/subagent stdout is piped and must stay clean).
 */
export function emitWarpCliAgentEvent(event: WarpCliAgentEvent, writer: NotificationWriter): void {
	if (isTerminalNotificationSuppressed()) return;
	writer(buildWarpCliAgentSequence(event));
}
