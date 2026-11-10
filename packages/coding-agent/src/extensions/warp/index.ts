/**
 * Builtin "warp" extension: maps hummin's session and agent lifecycle onto
 * Warp's CLI-agent protocol (OSC 777) so Warp shows task badges and inbox
 * entries for hummin runs — the mechanism behind Claude Code's branded tab
 * icon and inbox handling in Warp. Inert unless Warp negotiated the protocol
 * via WARP_CLI_AGENT_PROTOCOL_VERSION.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { emitWarpCliAgentEvent, isWarpCliAgentActive, type WarpCliAgentEvent } from "../../core/warp-cli-agent.ts";

/** Join a user message's text content (string or text blocks; images ignored). */
export function userMessageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export interface WarpAgentOutcome {
	readonly event: "stop" | "stop_failure";
	/** Final assistant text; absent for failures (nothing presentable to quote). */
	readonly response?: string;
}

/**
 * Outcome of a finished run for Warp's stop/stop_failure events, or undefined
 * when nothing should be reported: aborted runs (the user interrupted locally,
 * so Warp must not mark a completed task) and runs that produced no assistant
 * message. Failures carry no error payload; Warp's accepted error_type values
 * are undocumented, so the event name alone is the safe contract.
 */
export function agentOutcomeFromMessages(messages: readonly AgentMessage[]): WarpAgentOutcome | undefined {
	const last = findLastAssistant(messages);
	if (!last) return undefined;
	if (last.stopReason === "aborted") return undefined;
	if (last.stopReason === "error") return { event: "stop_failure" };
	return { event: "stop", response: assistantText(last) };
}

function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

const writeToStdout = (data: string): void => {
	process.stdout.write(data);
};

export default function warpCliAgentExtension(pi: ExtensionAPI): void {
	if (!isWarpCliAgentActive()) return;

	let activePrompt: string | undefined;
	const warpEvent = (
		ctx: ExtensionContext,
		partial: Omit<WarpCliAgentEvent, "sessionId" | "cwd">,
	): WarpCliAgentEvent => ({
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		...partial,
	});

	pi.on("session_start", (_event, ctx) => {
		emitWarpCliAgentEvent(warpEvent(ctx, { event: "session_start" }), writeToStdout);
	});

	pi.on("message_start", (message, ctx) => {
		if (message.message.role !== "user") return;
		activePrompt = userMessageText(message.message);
		emitWarpCliAgentEvent(warpEvent(ctx, { event: "prompt_submit", query: activePrompt }), writeToStdout);
	});

	pi.on("ui_prompt_start", (prompt, ctx) => {
		emitWarpCliAgentEvent(
			warpEvent(ctx, { event: "attention", kind: prompt.kind, title: prompt.title }),
			writeToStdout,
		);
	});

	pi.on("agent_end", (end, ctx) => {
		const outcome = agentOutcomeFromMessages(end.messages);
		if (!outcome) return;
		emitWarpCliAgentEvent(
			warpEvent(ctx, {
				event: outcome.event,
				query: activePrompt,
				...(outcome.response !== undefined ? { response: outcome.response } : {}),
			}),
			writeToStdout,
		);
	});
}
