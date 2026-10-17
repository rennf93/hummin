import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { default as humminAsk } from "../extensions/hummin-ask.ts";
import {
	ASK_INSTRUCTIONS,
	askGateHoldReason,
	askGateState,
	clearHeldDecision,
	extractUserTexts,
	heldDecisionFor,
	rememberHeldDecision,
	resetHeldDecisions,
	sys1AskGateCheck,
} from "../extensions/lib/ask-gate.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";

// Coverage for the sys1 ask gate (lib/ask-gate.ts + its wiring in
// hummin-ask.ts): stated-intent extraction, the bounded engine state, the
// hold/agree/fail-open decision, the held-question registry, the audit line,
// and the hybrid steer in the ask_user execute path (hold once, annotated
// re-ask). Fetch is stubbed in every test and env is pinned so results never
// depend on whether the local decision engine happens to be running.

interface FakeResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}

interface RecordedCall {
	url: string;
	body: string;
}

const cleanups: string[] = [];
let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "hummin-ask-gate-"));
	cleanups.push(agentDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("COLI_API_KEY", "test-key");
	vi.stubEnv("HUMMIN_DECISION_URL", "http://127.0.0.1:9987/v1/systemone");
	vi.stubEnv("HUMMIN_NOTIFY", "off");
	resetHeldDecisions();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const okResponse = (payload: unknown): FakeResponse => ({
	ok: true,
	status: 200,
	json: async () => payload,
	text: async () => JSON.stringify(payload),
});

/** A choice answer payload for one question. */
const choicePayload = (name: string, choice: string, probabilities?: Record<string, number>): unknown => ({
	answers: { [name]: { type: "choice", choice, probabilities: probabilities ?? { [choice]: 0.9 }, confidence: 0.9 } },
});

function stubFetch(handler: (call: RecordedCall) => Promise<unknown> | unknown): RecordedCall[] {
	const calls: RecordedCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown, init?: { body?: string }) => {
			const call = { url: String(url), body: init?.body ?? "" };
			calls.push(call);
			return (await handler(call)) as unknown;
		}),
	);
	return calls;
}

const CHOICES = ["Remove the honeypot feature", "Fix the honeypot so it blocks bots instead"];
const QUESTION = "How should we handle bots hitting the honeypot?";

/** Session entries shaped like SessionManager entries; only the fields the
 * gate reads are populated. */
function entry(role: "user" | "assistant" | "toolResult" | "other", content: unknown): unknown {
	if (role === "other") return { type: "model_change", provider: "p", modelId: "m" };
	return { type: "message", message: { role, content, timestamp: 0 } };
}

const INTENT_ENTRIES = [
	entry("user", "My original prompt was about honeypots not banning crawlers/bots. Keep every feature."),
	entry("assistant", [{ type: "text", text: "Understood, I will fix the gaps." }]),
	entry("user", [{ type: "text", text: "This should be a no brainer. We do not need to remove features." }]),
];

function fakeCtx(picked: () => string): { ctx: ExtensionContext; entries: unknown[] } {
	const entries = INTENT_ENTRIES;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: agentDir,
		signal: undefined,
		sessionManager: { getEntries: () => entries },
		ui: { custom: async () => picked() },
	} as unknown as ExtensionContext;
	return { ctx, entries };
}

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		update?: unknown,
		ctx?: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: unknown;
	}>;
}

function askTool(): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	const api = {
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		on: () => () => undefined,
		sendMessage: () => Promise.resolve(),
	} as unknown as ExtensionAPI;
	humminAsk(api);
	const tool = tools.get("ask_user");
	if (!tool) throw new Error("ask_user was not registered");
	return tool;
}

async function auditLines(): Promise<Array<Record<string, unknown>>> {
	const path = join(agentDir, "sys1-gate.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --- extractUserTexts ---------------------------------------------------------

test("extractUserTexts keeps only user message text, in order", () => {
	const texts = extractUserTexts(INTENT_ENTRIES);
	expect(texts).toHaveLength(2);
	expect(texts[0]).toContain("honeypots not banning crawlers");
	expect(texts[1]).toContain("no brainer");
});

// --- askGateState -------------------------------------------------------------

test("askGateState puts intent, question, options, and the recommendation in the state", () => {
	const state = askGateState(extractUserTexts(INTENT_ENTRIES), QUESTION, CHOICES, CHOICES[0]);
	expect(state).toContain("honeypots not banning crawlers");
	expect(state).toContain(QUESTION);
	expect(state).toContain(`1. ${CHOICES[0]}`);
	expect(state).toContain(`2. ${CHOICES[1]}`);
	expect(state).toContain(`as its recommendation: "${CHOICES[0]}"`);
	expect(state.length).toBeLessThanOrEqual(4000);
});

test("askGateState keeps the tail when the intent block overflows", () => {
	const big = Array.from({ length: 20 }, (_, i) => `msg ${i} ${"x".repeat(600)}`);
	const state = askGateState(big, QUESTION, CHOICES, CHOICES[0]);
	expect(state.length).toBeLessThanOrEqual(4000);
	expect(state).toContain("msg 19"); // most recent intent survives
	expect(state).not.toContain("msg 0 "); // oldest is cut
});

// --- sys1AskGateCheck ---------------------------------------------------------

const gateParams = () => ({
	userTexts: extractUserTexts(INTENT_ENTRIES),
	question: QUESTION,
	choices: CHOICES,
	recommendedLabel: CHOICES[0],
	cwd: agentDir,
});

test("confident disagreement holds: returns the engine pick and its probability", async () => {
	const calls = stubFetch(() =>
		okResponse(choicePayload("intent_match", CHOICES[1], { [CHOICES[0]]: 0.2, [CHOICES[1]]: 0.8 })),
	);
	const hold = await sys1AskGateCheck(gateParams());
	expect(hold).toEqual({ enginePick: CHOICES[1], p: 0.8 });
	expect(calls).toHaveLength(1);
	const body = JSON.parse(calls[0]?.body ?? "{}") as {
		state: string;
		questions: Record<string, { type: string; instructions: string; criteria: string[] }>;
	};
	expect(body.questions.intent_match?.type).toBe("choice");
	expect(body.questions.intent_match?.criteria).toEqual(Object.fromEntries(CHOICES.map((c) => [c, c])));
	expect(body.questions.intent_match?.instructions).toBe(ASK_INSTRUCTIONS);
	expect(body.state).toContain("honeypots not banning crawlers");
	// The read is audited like every other System-1 read.
	const lines = await auditLines();
	expect(lines.at(-1)).toMatchObject({ type: "read", kind: "ask", p: 0.8 });
});

test("agreement fails open: no hold, the read is still audited", async () => {
	stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[0])));
	const hold = await sys1AskGateCheck(gateParams());
	expect(hold).toBeUndefined();
	const lines = await auditLines();
	expect(lines.at(-1)).toMatchObject({ type: "read", kind: "ask" });
});

test("low-confidence disagreement fails open", async () => {
	stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[1], { [CHOICES[1]]: 0.55 })));
	const hold = await sys1AskGateCheck(gateParams());
	expect(hold).toBeUndefined();
});

test("every failure mode fails open with no audit line", async () => {
	// Unreachable engine.
	stubFetch(() => {
		throw new Error("ECONNREFUSED");
	});
	expect(await sys1AskGateCheck(gateParams())).toBeUndefined();
	// HTTP error.
	stubFetch(() => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }));
	expect(await sys1AskGateCheck(gateParams())).toBeUndefined();
	// Answer outside the criteria labels.
	stubFetch(() => okResponse(choicePayload("intent_match", "something else")));
	expect(await sys1AskGateCheck(gateParams())).toBeUndefined();
	// Missing probability mass entirely.
	stubFetch(() => okResponse({ answers: { intent_match: { type: "choice", choice: CHOICES[1] } } }));
	expect(await sys1AskGateCheck(gateParams())).toBeUndefined();
	expect(await auditLines()).toHaveLength(0);
});

test("the kill switch skips the read entirely", async () => {
	vi.stubEnv("HUMMIN_SYS1_ASK", "off");
	const calls = stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[1])));
	expect(await sys1AskGateCheck(gateParams())).toBeUndefined();
	expect(calls).toHaveLength(0);
});

test("decision.askGate=false skips the read entirely", async () => {
	// Project settings disable the gate (CONFIG_DIR_NAME/settings.json under cwd).
	mkdirSync(join(agentDir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(agentDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ decision: { askGate: false } }));
	const calls = stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[1])));
	await expect(sys1AskGateCheck(gateParams())).resolves.toBeUndefined();
	expect(calls).toHaveLength(0);
});

test("askGateHoldReason names both options and the escape hatch", () => {
	const reason = askGateHoldReason(CHOICES[1], 0.8, CHOICES[0]);
	expect(reason).toContain(CHOICES[1]);
	expect(reason).toContain(CHOICES[0]);
	expect(reason).toContain("re-ask the same question unchanged");
});

// --- held-question registry ----------------------------------------------------

test("held decisions expire after the TTL", () => {
	rememberHeldDecision("q", "b", 0.9, 1000);
	expect(heldDecisionFor("q", 1000 + 30 * 60 * 1000 - 1)).toEqual({ enginePick: "b", p: 0.9, at: 1000 });
	expect(heldDecisionFor("q", 1000 + 30 * 60 * 1000)).toBeUndefined();
});

test("held decisions evict the oldest entry beyond the cap", () => {
	for (let i = 0; i < 50; i++) rememberHeldDecision(`q${i}`, "b", 0.9, i);
	rememberHeldDecision("q-new", "b", 0.9, 10_000);
	expect(heldDecisionFor("q0", 10_001)).toBeUndefined(); // oldest evicted
	expect(heldDecisionFor("q-new", 10_001)).toBeDefined();
	expect(heldDecisionFor("q49", 10_001)).toBeDefined();
});

test("clearHeldDecision removes the entry (whitespace-normalized)", () => {
	rememberHeldDecision("  spaced  ", "b", 0.9, 1000);
	expect(heldDecisionFor("spaced", 1001)).toBeDefined();
	clearHeldDecision("spaced ");
	expect(heldDecisionFor("spaced", 1002)).toBeUndefined();
});

// --- ask_user execute-path wiring ---------------------------------------------

test("hold: the question never reaches the user; the model is steered back once", async () => {
	stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[1], { [CHOICES[0]]: 0.15, [CHOICES[1]]: 0.85 })));
	const heldCtx = fakeCtx(() => {
		throw new Error("the selector must not open on a held question");
	});
	const res = await askTool().execute(
		"t1",
		{ question: QUESTION, choices: CHOICES, recommended: 0 },
		undefined,
		undefined,
		heldCtx.ctx,
	);
	expect(res.details).toMatchObject({ cancelled: true });
	expect(JSON.stringify(res.content)).toContain("sys1 ask gate");
	expect(JSON.stringify(res.content)).toContain(CHOICES[1]);
	// The hold is remembered: the re-ask skips the engine read and opens the
	// selector annotated with both opinions. The agent keeps its pick; the
	// user decides.
	const second = stubFetch(() => {
		throw new Error("a re-ask of a held question must not hit the engine");
	});
	const reaskCtx = fakeCtx(() => CHOICES[0]);
	const res2 = await askTool().execute(
		"t2",
		{ question: QUESTION, choices: CHOICES, recommended: 0 },
		undefined,
		undefined,
		reaskCtx.ctx,
	);
	expect(second).toHaveLength(0);
	expect(res2.details).toMatchObject({ cancelled: false, choice: CHOICES[0] });
	const details2 = res2.details as { notice?: string };
	expect(details2.notice).toContain("engine favors");
	// A third ask (registry entry consumed) re-arms the gate.
	stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[0])));
	const res3 = await askTool().execute(
		"t3",
		{ question: QUESTION, choices: CHOICES, recommended: 0 },
		undefined,
		undefined,
		reaskCtx.ctx,
	);
	expect(res3.details).toMatchObject({ choice: CHOICES[0] });
});

test("no recommendation: no engine read at all", async () => {
	const calls = stubFetch(() => okResponse(choicePayload("intent_match", CHOICES[1])));
	const { ctx } = fakeCtx(() => CHOICES[1]);
	await askTool().execute("t1", { question: QUESTION, choices: CHOICES }, undefined, undefined, ctx);
	expect(calls).toHaveLength(0);
});
