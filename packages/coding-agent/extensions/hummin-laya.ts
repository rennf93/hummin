/**
 * hummin-laya: laya System-1 decision tool for the local fleet.
 *
 * laya_decide sends a state plus typed questions (choice / score / noul) to
 * the laya service (launchd com.hummin.laya, port 9989, served by
 * ~/colibri/serve-laya.sh) and returns calibrated answers in a single forward
 * pass. laya generates no text, so it cannot hallucinate an answer: it is a
 * fast second opinion for the main model when it is torn between options,
 * unsure whether to proceed, or wants a confidence check before acting.
 *
 * Logs: ~/Library/Logs/laya-server.log
 * Restart: launchctl kickstart -k gui/501/com.hummin.laya
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LAYA_URL = process.env.HUMMIN_LAYA_URL?.trim() || "http://127.0.0.1:9989/v1/systemone";
/** Shared fleet key from the environment (exported in ~/.zshrc, same source as
 * hummin-local.ts uses). Never hardcoded here: extensions can end up in repos
 * and screenshots; the literal key only lives in the serve scripts and plists. */
const LAYA_API_KEY = process.env.COLI_API_KEY?.trim() || "";
const TIMEOUT_MS = 15_000;
const MAX_QUESTIONS = 8;
const MAX_STATE_CHARS = 50_000;
const LOW_CONFIDENCE = 0.5;

type QuestionType = "choice" | "score" | "noul";

interface QuestionInput {
	name: string;
	type: QuestionType;
	instructions: string;
	criteria?: Record<string, string> | string[];
}

interface Answer {
	type?: string;
	choice?: string;
	score?: number;
	noul?: number;
	probabilities?: Record<string, number>;
	legend?: Record<string, string>;
	confidence?: number;
	answer_confidence?: number;
}

interface LayaResponse {
	answers?: Record<string, Answer>;
	routing?: { model?: string };
}

const pct = (n: number | undefined): string =>
	typeof n === "number" ? `${Math.round(n * 100)}%` : "?";

// --- Automatic System-1 reads (no model opt-in required) ---
// Two kill switches: HUMMIN_LAYA_STEER=off disables the per-turn read,
// HUMMIN_LAYA_GATE=off disables the bash tripwire. Both fail open: if laya
// is unreachable or slow, the turn and the command proceed untouched.

const STEER_MIN_PROMPT_CHARS = 24;
const STEER_DESTRUCTIVE_THRESHOLD = 0.7;
const GATE_BLOCK_THRESHOLD = 0.75;
const GATE_TIMEOUT_MS = 4_000;
const GATE_CONFIRM_MARKER = "# laya-gate: confirmed";
const READ_ONLY_BASH =
	/^\s*(ls|pwd|cat|head|tail|grep|rg|find|which|type|file|stat|du|df|wc|date|whoami|env|printenv|echo|node --version|npm (ls|outdated|test|view|run)|git (status|log|diff|show|branch|remote|tag))\b/;

interface LayaNoulPayload {
	answers?: Record<string, { noul?: number; confidence?: number }>;
}

/** One-question noul read from laya; null on any failure or timeout. */
async function layaNoul(state: string, name: string, instructions: string): Promise<{ noul: number } | null> {
	if (!LAYA_API_KEY) return null;
	try {
		const response = await fetch(LAYA_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${LAYA_API_KEY}` },
			body: JSON.stringify({ state, questions: { [name]: { type: "noul", instructions } } }),
			signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as LayaNoulPayload;
		const answer = payload.answers?.[name];
		return typeof answer?.noul === "number" ? { noul: answer.noul } : null;
	} catch {
		return null;
	}
}

function formatAnswer(name: string, q: QuestionInput, a: Answer): string {
	switch (q.type) {
		case "choice": {
			const top = a.choice ?? "(none)";
			const others = Object.entries(a.probabilities ?? {})
				.filter(([label]) => label !== top)
				.sort((x, y) => y[1] - x[1])
				.map(([label, p]) => `${label} ${pct(p)}`)
				.join(", ");
			return `${name}: ${top} (${pct(a.probabilities?.[top])}${others ? `; then ${others}` : ""})`;
		}
		case "score": {
			const levels = (q.criteria as string[] | undefined) ?? Object.values(a.legend ?? {});
			const s = typeof a.score === "number" ? a.score : -1;
			const nearest = s >= 0 ? levels[Math.min(levels.length - 1, Math.max(0, Math.round(s)))] : "?";
			return `${name}: ${s >= 0 ? s.toFixed(2) : "?"} of ${levels.length - 1} ("${nearest}"), top mass ${pct(
				Math.max(...Object.values(a.probabilities ?? { 0: 0 })),
			)}`;
		}
		case "noul": {
			const p = typeof a.noul === "number" ? a.noul : -1;
			const verdict = p < 0 ? "?" : p >= 0.5 ? "yes" : "no";
			return `${name}: P(true) ${p >= 0 ? p.toFixed(3) : "?"} -> lean ${verdict} (${pct(
				Math.max(p, 1 - p),
			)} sure)`;
		}
	}
}

export default function humminLaya(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "laya_decide",
		label: "Laya Decide",
		description:
			"Fast calibrated second opinion (System-1) on structured decisions: pick between named options, a yes/no judgment with P(true), or a rating on an ordinal rubric. One forward pass, no text generation, so it cannot make things up. Consult it when you are torn between options, unsure whether to proceed with a risky action, or want an independent confidence check on a decision. It cannot do open Q&A, reasoning, or more than ~20 options.",
		promptSnippet:
			"laya_decide: ask the laya System-1 engine for a calibrated second opinion on a choice, yes/no gate, or rubric score before committing to a decision",
		parameters: Type.Object({
			state: Type.String({
				description:
					"The situation to decide over: the relevant facts, constraints, and the options or claim in context (max 50k chars). laya reads only this text, so include everything the decision needs.",
			}),
			questions: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short snake_case key for the answer, e.g. proceed_first" }),
					type: Type.Union([Type.Literal("choice"), Type.Literal("score"), Type.Literal("noul")], {
						description: "choice = pick one option, score = ordinal rubric level, noul = yes/no with P(true)",
					}),
					instructions: Type.String({ description: "What to decide, phrased as a question over the state" }),
					criteria: Type.Optional(
						Type.Union([Type.Record(Type.String(), Type.String()), Type.Array(Type.String())], {
							description:
								"choice: object mapping label -> description (or array of labels). score: array of level descriptions ordered worst to best. noul: optional object with optional 'true'/'false' descriptions.",
						}),
					),
				}),
				{ maxItems: MAX_QUESTIONS, description: `1 to ${MAX_QUESTIONS} questions, answered in one pass` },
			),
		}),
		async execute(_toolCallId, params) {
			if (!LAYA_API_KEY) {
				return {
					content: [{ type: "text", text: "Error: COLI_API_KEY is not set in this Hummin process. Export it (it is in ~/.zshrc) and restart Hummin." }],
					isError: true,
					details: {},
				};
			}
			if (!params.state.trim()) {
				return { content: [{ type: "text", text: "Error: empty state" }], isError: true, details: {} };
			}
			if (params.questions.length === 0) {
				return { content: [{ type: "text", text: "Error: no questions given" }], isError: true, details: {} };
			}

			const questions: Record<string, unknown> = {};
			for (const q of params.questions) {
				if (!/^[a-zA-Z0-9_-]{1,64}$/.test(q.name)) {
					return {
						content: [{ type: "text", text: `Error: question name '${q.name}' must be snake_case, max 64 chars` }],
						isError: true,
						details: {},
					};
				}
				questions[q.name] = q.criteria !== undefined
					? { type: q.type, instructions: q.instructions, criteria: q.criteria }
					: { type: q.type, instructions: q.instructions };
			}

			let response: Response;
			try {
				response = await fetch(LAYA_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${LAYA_API_KEY}` },
					body: JSON.stringify({ state: params.state.slice(0, MAX_STATE_CHARS), questions }),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
			} catch (err) {
				const msg = err instanceof Error && /abort|timeout/i.test(err.message)
					? `laya did not answer within ${TIMEOUT_MS / 1000}s`
					: `laya service unreachable at ${LAYA_URL}`;
				return {
					content: [{
						type: "text",
						text: `${msg}. Check it with: curl -m 3 http://127.0.0.1:9989/health, restart with: launchctl kickstart -k gui/501/com.hummin.laya`,
					}],
					isError: true,
					details: {},
				};
			}

			if (!response.ok) {
				const detail = (await response.text()).slice(0, 300);
				return {
					content: [{ type: "text", text: `laya returned HTTP ${response.status}: ${detail}` }],
					isError: true,
					details: {},
				};
			}

			const payload = (await response.json()) as LayaResponse;
			const lines: string[] = [];
			for (const q of params.questions) {
				const a = payload.answers?.[q.name];
				lines.push(a ? formatAnswer(q.name, q, a) : `${q.name}: (no answer returned)`);
			}
			const weakest = Math.min(
				...params.questions
					.map((q) => payload.answers?.[q.name]?.answer_confidence ?? payload.answers?.[q.name]?.confidence)
					.filter((c): c is number => typeof c === "number"),
			);
			if (isFinite(weakest) && weakest < LOW_CONFIDENCE) {
				lines.push(
					`note: weakest answer confidence ${pct(weakest)} is below ${pct(LOW_CONFIDENCE)}; weigh your own judgment and the state text more than laya here`,
				);
			}
			if (payload.routing?.model) {
				lines.push(`(laya checkpoint: ${payload.routing.model})`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	// Per-turn steering: read the user prompt before the agent starts and, only
	// when laya is confident the request involves destructive action, inject a
	// quiet context message steering the model to verify and confirm first.
	if (process.env.HUMMIN_LAYA_STEER !== "off") {
		pi.on("before_agent_start", async (event) => {
			const prompt = event.prompt.trim();
			if (prompt.length < STEER_MIN_PROMPT_CHARS || prompt.startsWith("/")) return undefined;
			const read = await layaNoul(
				prompt.slice(0, 4000),
				"destructive_intent",
				"Fulfilling this request requires destructive or hard-to-reverse actions such as deleting, overwriting, force-pushing, or dropping data.",
			);
			if (!read || read.noul < STEER_DESTRUCTIVE_THRESHOLD) return undefined;
			return {
				message: {
					customType: "laya-read",
					content: `[laya System-1 read, P=${read.noul.toFixed(2)}] This request may require destructive or hard-to-reverse actions. Before deleting, overwriting, or dropping anything: verify the exact target, check it is backed up or reproducible, and ask the user if the scope is not explicit.`,
					display: false,
					details: {},
				},
			};
		});
	}

	// Bash tripwire: laya reads each non-read-only command before it runs and
	// blocks it once when it scores P >= 0.75 as irreversibly destructive. The
	// block reason makes the model confirm with the user or verify backups;
	// re-running with the confirm marker documents that and passes the gate.
	if (process.env.HUMMIN_LAYA_GATE !== "off") {
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const trimmed = command.trim();
			if (!trimmed || trimmed.includes(GATE_CONFIRM_MARKER)) return undefined;
			const segments = trimmed.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
			if (segments.length > 0 && segments.every((s) => READ_ONLY_BASH.test(s))) return undefined;
			const read = await layaNoul(
				`A coding agent is about to run this bash command in the user's project directory:\n\n${trimmed.slice(0, 2000)}`,
				"destructive",
				"If run as-is, this command would irreversibly destroy work that is not recoverable: user files, git history, databases, or data that is not backed up.",
			);
			if (!read || read.noul < GATE_BLOCK_THRESHOLD) return undefined;
			return {
				block: true,
				reason: `[laya gate] laya scores this command P=${read.noul.toFixed(2)} as irreversibly destructive. Do not simply retry it. Either (1) confirm with the user that the target is disposable, or (2) verify it is backed up or reproducible. Once confirmed, re-run the same command with '${GATE_CONFIRM_MARKER}' appended so the gate lets it through.`,
			};
		});
	}
}
