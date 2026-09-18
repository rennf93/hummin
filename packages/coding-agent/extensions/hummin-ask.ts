/** ask_user: structured multi-choice question rendered as a TUI selector. */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const QUESTION_MAX = 500;
export const CHOICE_MAX = 80;
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 6;
export const FREE_TEXT_LABEL = "Other...";

export interface AskUserResult {
	choice: string;
	cancelled: boolean;
	notice?: string;
}

/** Trim and truncate the question; throws when nothing usable remains. */
export function normalizeQuestion(raw: string): string {
	const question = raw.trim().slice(0, QUESTION_MAX);
	if (!question) throw new Error("ask_user: question must be a non-empty string");
	return question;
}

/** Trim, truncate to CHOICE_MAX, and reject duplicate or empty labels. */
export function normalizeChoices(raw: string[]): string[] {
	const choices: string[] = [];
	for (const item of raw) {
		const label = item.trim().slice(0, CHOICE_MAX);
		if (!label) throw new Error("ask_user: choices must be non-empty strings");
		if (choices.includes(label)) throw new Error(`ask_user: duplicate choice "${label}"`);
		choices.push(label);
	}
	if (choices.length < CHOICES_MIN || choices.length > CHOICES_MAX) {
		throw new Error(`ask_user: requires ${CHOICES_MIN}-${CHOICES_MAX} choices, got ${choices.length}`);
	}
	return choices;
}

/** Selector options, with the free-text escape hatch appended when allowed. */
export function buildOptions(choices: readonly string[], allowFreeText: boolean): string[] {
	return allowFreeText ? [...choices, FREE_TEXT_LABEL] : [...choices];
}

/** Validate params up front so bad calls fail before any UI is shown. */
export function validateAskParams(params: { question: string; choices: string[]; allowFreeText?: boolean }): {
	question: string;
	choices: string[];
} {
	return { question: normalizeQuestion(params.question), choices: normalizeChoices(params.choices) };
}

function result(choice: string, cancelled: boolean, notice?: string): AskUserResult {
	return notice === undefined ? { choice, cancelled } : { choice, cancelled, notice };
}

function toolResult(out: AskUserResult): { content: { type: "text"; text: string }[]; details: AskUserResult } {
	const text = out.cancelled
		? "ask_user: the user dismissed the question. Do not retry with the same question; proceed with your best judgment."
		: `ask_user: "${out.choice}"${out.notice ? ` (${out.notice})` : ""}`;
	return { content: [{ type: "text", text }], details: out };
}

async function askInteractive(
	question: string,
	choices: readonly string[],
	allowFreeText: boolean,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<AskUserResult> {
	const picked = await ctx.ui.select(question, buildOptions(choices, allowFreeText), { signal });
	if (signal?.aborted || picked === undefined) return result("", true);
	if (picked !== FREE_TEXT_LABEL) return result(picked, false);
	const text = await ctx.ui.input(question, "Type your answer", { signal });
	const trimmed = (text ?? "").trim();
	if (signal?.aborted || !trimmed) return result("", true);
	return result(trimmed, false);
}

export default function humminAsk(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question with 2-6 explicit choices and return the picked answer. Use when a decision is genuinely the user's to make (ambiguous scope, destructive action, missing requirement). Set allowFreeText to also offer an open-form answer. Cancelled means the user declined to answer.",
		promptSnippet: "ask_user: ask the user a multiple-choice question and return the answer",
		parameters: Type.Object({
			question: Type.String({ minLength: 1, maxLength: QUESTION_MAX, description: "The question to ask" }),
			choices: Type.Array(
				Type.String({ minLength: 1, maxLength: CHOICE_MAX }),
				{ minItems: CHOICES_MIN, maxItems: CHOICES_MAX, description: "The answer options" },
			),
			allowFreeText: Type.Optional(
				Type.Boolean({ description: "Also offer a free-form 'Other...' answer (default false)" }),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const { question, choices } = validateAskParams(params);
			const allowFreeText = params.allowFreeText ?? false;
			signal?.throwIfAborted();
			if (ctx.mode !== "tui") {
				return toolResult(result(choices[0], false, "non-interactive: defaulted to first choice"));
			}
			return toolResult(await askInteractive(question, choices, allowFreeText, ctx, signal));
		},
	});
}
