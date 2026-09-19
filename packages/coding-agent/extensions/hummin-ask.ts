/** ask_user: structured multi-choice question rendered as a TUI selector. */
import { type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const QUESTION_MAX = 500;
export const CHOICE_MAX = 80;
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 6;
export const FREE_TEXT_LABEL = "Other...";
export const QUESTION_HINT = "↑/↓ navigate · enter select · escape cancel · tab free-text";
export const QUESTION_HINT_PLAIN = "↑/↓ navigate · enter select · escape cancel";

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

/**
 * Bordered question selector in the fleet-panel visual language.
 * One instance per ask; `done` fires exactly once; dispose removes the abort listener.
 */
export class QuestionComponent implements Component {
	private selected = 0;
	private disposed = false;
	private readonly options: readonly string[];
	private readonly onAbort: () => void;
	private readonly question: string;
	private readonly allowFreeText: boolean;
	private readonly done: (picked: string | undefined) => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly signal: AbortSignal | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		question: string,
		options: readonly string[],
		allowFreeText: boolean,
		done: (picked: string | undefined) => void,
		signal: AbortSignal | undefined,
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.question = question;
		this.options = options;
		this.allowFreeText = allowFreeText;
		this.done = done;
		this.signal = signal;
		this.onAbort = () => this.finish(undefined);
		signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	/** Resolve exactly once; safe against double done/abort races. */
	private finish(picked: string | undefined): void {
		if (this.disposed) return;
		this.disposed = true;
		this.signal?.removeEventListener("abort", this.onAbort);
		this.done(picked);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
			return;
		}
		if (this.kb.matches(data, "tui.select.up"))
			this.selected = (this.selected + this.options.length - 1) % this.options.length;
		else if (this.kb.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.options.length;
		else if (this.kb.matches(data, "tui.select.confirm")) {
			this.finish(this.options[this.selected]);
			return;
		}
		this.tui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.signal?.removeEventListener("abort", this.onAbort);
	}

	invalidate(): void {}

	private padLine(content: string, width: number): string {
		const inner = truncateToWidth(` ${content} `, Math.max(1, width - 2));
		const pad = Math.max(0, width - 2 - visibleWidth(inner));
		return `│${inner}${" ".repeat(pad)}│`;
	}

	render(width: number): string[] {
		const top = `╭${"─".repeat(Math.max(0, width - 2))}╮`;
		const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
		const lines: string[] = [
			top,
			this.padLine(this.theme.fg("accent", this.theme.bold(this.question)), width),
			this.padLine("", width),
		];
		for (const [index, option] of this.options.entries()) {
			const marker = index === this.selected ? this.theme.fg("accent", "▸") : " ";
			const number = this.theme.fg("dim", `${index + 1}.`);
			lines.push(this.padLine(`${marker} ${number} ${option}`, width));
		}
		lines.push(
			this.padLine("", width),
			this.padLine(this.theme.fg("dim", this.allowFreeText ? QUESTION_HINT : QUESTION_HINT_PLAIN), width),
			bottom,
		);
		return lines;
	}
}

/** Race a host UI promise against abort so the tool can never outlive its signal. */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
	if (!signal) return await promise;
	if (signal.aborted) return undefined;
	return await new Promise<T | undefined>((resolve, reject) => {
		let settled = false;
		const onAbort = () => settle(() => resolve(undefined));
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			fn();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => settle(() => resolve(value)),
			(err) => settle(() => reject(err)),
		);
	});
}

export async function askInteractive(
	question: string,
	choices: readonly string[],
	allowFreeText: boolean,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<AskUserResult> {
	const options = buildOptions(choices, allowFreeText);
	const picked = await withAbort(
		ctx.ui.custom<string | undefined>(
			(tui, theme, kb, done) => new QuestionComponent(tui, theme, kb, question, options, allowFreeText, done, signal),
		),
		signal,
	);
	if (signal?.aborted || picked === undefined) return result("", true);
	if (picked !== FREE_TEXT_LABEL) return result(picked, false);
	const text = await withAbort(ctx.ui.input(question, "Type your answer", { signal }), signal);
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
