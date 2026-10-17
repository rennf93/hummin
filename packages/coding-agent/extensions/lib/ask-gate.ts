/**
 * lib/ask-gate: the ask_user recommendation gate.
 *
 * One System-1 choice read over each ask_user call that carries a
 * recommendation: given the session's recent user messages (the stated
 * intent), the question, and the options, the engine picks the option that
 * best matches what the user actually asked for. A confident disagreement
 * with the model's recommendation holds the question once and steers the
 * model back with the disagreement; an unchanged re-ask is shown to the user
 * annotated with both opinions. Every other outcome fails open: the question
 * proceeds exactly as the model asked it, and an unreachable or slow engine
 * never delays more than the gate timeout.
 *
 * Kill switches: HUMMIN_SYS1_ASK=off (env) and settings decision.askGate=false.
 * Threshold: decision.askThreshold / HUMMIN_DECISION_ASK_THRESHOLD (default 0.7).
 * Every read that returned a pick is appended to sys1-gate.log as
 * {ts, type: "read", kind: "ask", p}.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveDecisionEngine, sys1Choice, sys1Disabled } from "./decision-engine.ts";

/** How many recent user messages form the stated-intent block, and the per
 * message / whole-block char bounds (the block keeps the TAIL: the most
 * recent intent matters most). */
const INTENT_MAX_MESSAGES = 6;
const INTENT_MESSAGE_CHARS = 700;
const INTENT_BLOCK_CHARS = 4000;

/** The engine read's decision question. Deliberately counter-anchors: the
 * state contains the agent's recommendation (that is the thing under test),
 * so the instructions tell the engine to ignore it and judge the user's
 * words only. */
export const ASK_INSTRUCTIONS = [
	"Decide exactly one question: which of these options best matches what the user asked for in their recent messages?",
	"Judge only against the user's stated intent as written; ignore which option the agent recommends - the recommendation may contradict the request.",
	"If two options both plausibly match, pick the closer one. If none matches, pick the one that conflicts least with the stated intent.",
].join(" ");

/** Extract the text of recent user messages, oldest first, for the intent
 * block. Duck-typed so it works against SessionEntry shapes without a
 * runtime import; non-text content (images, tool plumbing) contributes
 * nothing. Empty strings and empty results are dropped. */
export function extractUserTexts(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const message = (entry as { message?: unknown }).message;
		if (typeof message !== "object" || message === null) continue;
		if ((message as { role?: unknown }).role !== "user") continue;
		const content: unknown = (message as { content?: unknown }).content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const part of content) {
				if (typeof part !== "object" || part === null) continue;
				const p = part as { type?: unknown; text?: unknown };
				if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
			}
			text = parts.join("\n");
		}
		text = text.replace(/\s+/g, " ").trim();
		if (text) texts.push(text);
	}
	return texts;
}

/** Pure: the bounded state text for the recommendation read. */
export function askGateState(
	userTexts: readonly string[],
	question: string,
	choices: readonly string[],
	recommendedLabel: string,
): string {
	const recent = userTexts.slice(-INTENT_MAX_MESSAGES).map((t) => `- ${t.slice(0, INTENT_MESSAGE_CHARS)}`);
	const intentBlock = recent.length > 0 ? recent.join("\n") : "(no user messages captured this session)";
	const options = choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
	const state = [
		"A coding agent is about to ask the user a multiple-choice question.",
		"",
		"The user's recent messages this session, oldest first (the stated intent):",
		"",
		intentBlock,
		"",
		"The question:",
		"",
		question,
		"",
		"The options:",
		"",
		options,
		"",
		`The agent marked this option as its recommendation: "${recommendedLabel}"`,
	].join("\n");
	return state.length > INTENT_BLOCK_CHARS ? state.slice(-INTENT_BLOCK_CHARS) : state;
}

/** Audit trail: one JSON line per ask read that returned a pick, same shape
 * as the other System-1 reads' audit lines (hummin-sys1.ts, memory-workers). */
function auditAskRead(p: number): void {
	try {
		appendFileSync(
			join(getAgentDir(), "sys1-gate.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), type: "read", kind: "ask", p })}\n`,
		);
	} catch {
		// Audit logging must never break the gate itself.
	}
}

/** A confident disagreement: the engine's pick and its probability mass. */
export interface AskGateHold {
	enginePick: string;
	p: number;
}

/**
 * Full ask-gate decision for one ask_user call with a recommendation.
 * Returns the hold when the engine confidently picks a different option as
 * the better match for the stated intent; undefined in every other case
 * (disabled, unconfigured engine, failed read, agreement, low-confidence
 * disagreement) so the caller proceeds untouched. Never throws.
 */
export async function sys1AskGateCheck(params: {
	userTexts: readonly string[];
	question: string;
	choices: readonly string[];
	recommendedLabel: string;
	cwd: string;
}): Promise<AskGateHold | undefined> {
	try {
		if (sys1Disabled("HUMMIN_SYS1_ASK")) return undefined;
		const engine = resolveDecisionEngine(params.cwd);
		if (engine.unconfigured || !engine.askGate) return undefined;
		const read = await sys1Choice(
			engine,
			askGateState(params.userTexts, params.question, params.choices, params.recommendedLabel),
			"intent_match",
			ASK_INSTRUCTIONS,
			params.choices,
			engine.gateTimeoutMs,
		);
		if (!read) return undefined;
		const p = read.probabilities[read.choice] ?? read.confidence;
		if (typeof p !== "number") return undefined;
		auditAskRead(p);
		if (read.choice === params.recommendedLabel) return undefined;
		if (p < engine.askThreshold) return undefined;
		return { enginePick: read.choice, p };
	} catch {
		// The gate must never break asking.
		return undefined;
	}
}

/** The tool-result text shown to the model when its question is held. */
export function askGateHoldReason(enginePick: string, p: number, recommendedLabel: string): string {
	return (
		`[sys1 ask gate] Held before showing the user. Given the conversation so far, the System-1 engine reads "${enginePick}" ` +
		`(P=${p.toFixed(2)}) as the option that best matches the user's stated intent - not your recommendation ("${recommendedLabel}"). ` +
		"Re-read the user's actual request. If your recommendation still stands, re-ask the same question unchanged and it will be shown to the user " +
		"annotated with both opinions; otherwise correct the options or the recommendation first."
	);
}

// --- Held-question registry --------------------------------------------------
//
// Questions the gate has held once, keyed by normalized question text. A
// re-ask of a held question skips the engine read and renders annotated with
// the stored disagreement (hybrid steer: one hold, then the user decides
// with full information). Entries expire so state cannot leak across
// unrelated sessions reusing identical question text.

const HELD_TTL_MS = 30 * 60 * 1000;
const HELD_MAX = 50;

interface HeldEntry {
	enginePick: string;
	p: number;
	at: number;
}

const heldQuestions = new Map<string, HeldEntry>();

/** The live held entry for this question, or undefined (expired entries are
 * evicted on read). */
export function heldDecisionFor(question: string, now: number): HeldEntry | undefined {
	const key = question.trim();
	const entry = heldQuestions.get(key);
	if (!entry) return undefined;
	if (now - entry.at >= HELD_TTL_MS) {
		heldQuestions.delete(key);
		return undefined;
	}
	return entry;
}

export function rememberHeldDecision(question: string, enginePick: string, p: number, now: number): void {
	const key = question.trim();
	if (heldQuestions.size >= HELD_MAX) {
		const oldest = [...heldQuestions.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (oldest) heldQuestions.delete(oldest[0]);
	}
	heldQuestions.set(key, { enginePick, p, at: now });
}

export function clearHeldDecision(question: string): void {
	heldQuestions.delete(question.trim());
}

/** Test-only: drop all held-question state. */
export function resetHeldDecisions(): void {
	heldQuestions.clear();
}
