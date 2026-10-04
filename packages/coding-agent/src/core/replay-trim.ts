// hummin: replay trimming. Every stateless LLM API replays the full conversation
// on each request, and the replay includes data the model no longer needs:
// reasoning/thinking blocks from completed turns and stale tool outputs. For
// GLM-family endpoints z.ai explicitly recommends not resending reasoning; for
// llama.cpp-style local servers the chat templates usually drop it anyway, so
// it is pure context-window waste. This module rewrites the per-request context
// (never the session history) before it reaches the provider client.
//
// Boundary: everything before the LAST user message is a completed turn. The
// active tool loop after it (assistant thinking/tool calls + tool results)
// always passes through untouched - some APIs require the thinking block of the
// final assistant message during tool use.
//
// Provider safety:
// - anthropic-messages: strips non-redacted thinking. Redacted thinking carries
//   an opaque encrypted payload and is kept. Real Anthropic strips prior-turn
//   thinking server-side anyway; anthropic-compatible endpoints (z.ai) accept
//   stripped history.
// - openai-completions: strips thinking blocks whose signature is absent or a
//   plain reasoning field name ("reasoning", "reasoning_content", ...). Blocks
//   carrying structured/encrypted replay data (e.g. OpenRouter reasoning_details)
//   are kept - those endpoints replay them for correctness.
// - other APIs: untouched until verified.
// Endpoints that require the reasoning field to exist are handled downstream by
// the AI layer, which re-adds an empty `reasoning_content` (compat
// requiresReasoningContentOnAssistantMessages) - so a strip degrades to an
// empty field, never to a missing field.

import type { Context, TextContent, ThinkingContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { isOpenAICompletionsReasoningField } from "@earendil-works/pi-ai/api/openai-completions";

/** hummin settings shape for replay trimming (settings key `replayTrim`). */
export interface ReplayTrimSettings {
	/** Drop replayed reasoning from completed turns. Default: true. */
	thinking?: boolean;
	/** Prune old tool results to head+marker+tail. Default: true (mirrors the
	 * zcode-token-proxy "all" mode; set false for lossless replay). */
	toolResults?: boolean;
	/** Head characters kept when pruning a tool result. Default: 2000. */
	toolResultCap?: number;
	/** Tail characters kept when pruning a tool result. Default: 200. */
	toolResultTail?: number;
}

export interface ResolvedReplayTrimOptions {
	thinking: boolean;
	toolResults: boolean;
	toolResultCap: number;
	toolResultTail: number;
}

/** A tool result must exceed cap + tail by this margin to be worth pruning. */
const PRUNE_MARGIN = 200;

export function resolveReplayTrimSettings(settings: ReplayTrimSettings | undefined): ResolvedReplayTrimOptions {
	return {
		thinking: settings?.thinking ?? true,
		toolResults: settings?.toolResults ?? true,
		toolResultCap: Math.max(0, settings?.toolResultCap ?? 2000),
		toolResultTail: Math.max(0, settings?.toolResultTail ?? 200),
	};
}

function stripThinking(api: string, block: ThinkingContent): boolean {
	if (block.redacted) return false; // opaque encrypted payload - kept
	if (api === "anthropic-messages") return true;
	if (api === "openai-completions") {
		const signature = block.thinkingSignature;
		// Plain-field signatures mean the reasoning is replayed as a flat string
		// (waste). Anything else (structured/encrypted replay data) must go back.
		return signature === undefined || signature.trim().length === 0 || isOpenAICompletionsReasoningField(signature);
	}
	return false; // unknown API - keep replay until verified
}

function pruneText(text: string, options: ResolvedReplayTrimOptions): string | undefined {
	const limit = options.toolResultCap + options.toolResultTail + PRUNE_MARGIN;
	if (text.length <= limit) return undefined;
	const cut = text.length - options.toolResultCap - options.toolResultTail;
	const marker = `\n[old tool result trimmed: ${cut} chars cut to save context; rerun the tool if you need the full output]\n`;
	const tail = options.toolResultTail > 0 ? text.slice(text.length - options.toolResultTail) : "";
	return text.slice(0, options.toolResultCap) + marker + tail;
}

/**
 * Return `context` with completed turns rewritten for replay. Copy-on-write:
 * untouched messages keep their references, so callers may hold the original
 * objects (session history is never modified).
 */
export function trimReplayContext<T extends Context>(context: T, api: string, options: ResolvedReplayTrimOptions): T {
	if (!options.thinking && !options.toolResults) return context;
	const messages = context.messages;
	let lastUser = -1;
	for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i;
	if (lastUser <= 0) return context; // nothing before the first user turn to trim
	let changed = false;
	const out = messages.slice();
	for (let i = 0; i < lastUser; i++) {
		const message = out[i];
		if (!message) continue;
		if (options.thinking && message.role === "assistant") {
			const content = message.content;
			const kept = content.filter((block) => {
				if (block.type !== "thinking") return true;
				return !stripThinking(api, block);
			});
			// Never empty an assistant message: a thinking-only turn would vanish
			// from the wire entirely (possibly leaving two adjacent user turns).
			if (kept.length === 0) continue;
			if (kept.length !== content.length) {
				out[i] = { ...message, content: kept };
				changed = true;
			}
		}
		if (options.toolResults && message.role === "toolResult") {
			const toolResult = message as ToolResultMessage;
			let blocksChanged = false;
			const blocks = toolResult.content.map((block) => {
				if (block.type !== "text") return block;
				const pruned = pruneText((block as TextContent).text, options);
				if (pruned === undefined) return block;
				blocksChanged = true;
				return { type: "text", text: pruned } satisfies TextContent;
			});
			if (blocksChanged) {
				out[i] = { ...toolResult, content: blocks };
				changed = true;
			}
		}
	}
	if (!changed) return context;
	return { ...context, messages: out };
}
