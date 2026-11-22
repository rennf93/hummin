/** ask_user: structured multi-choice question rendered as a TUI selector. */
import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	SettingsManager,
	sendTerminalNotification,
} from "@earendil-works/pi-coding-agent";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	askGateHoldReason,
	clearHeldDecision,
	extractUserTexts,
	heldDecisionFor,
	rememberHeldDecision,
	sys1AskGateCheck,
} from "./lib/ask-gate.ts";

export const QUESTION_MAX = 500;
export const CHOICE_MAX = 80;
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 6;
export const QUESTION_HINT = "↑/↓ navigate · enter select · ❯ type a free answer · esc cancel";
export const QUESTION_HINT_PLAIN = "↑/↓ navigate · enter select · escape cancel";
export const INPUT_HINT = "enter submit · esc back";

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

/** Validate params up front so bad calls fail before any UI is shown. */
export function validateAskParams(params: {
	question: string;
	choices: string[];
	allowFreeText?: boolean;
	recommended?: number;
}): { question: string; choices: string[]; recommended?: number } {
	const question = normalizeQuestion(params.question);
	const choices = normalizeChoices(params.choices);
	if (
		params.recommended !== undefined &&
		(!Number.isInteger(params.recommended) || params.recommended < 0 || params.recommended >= choices.length)
	) {
		throw new Error("ask_user: recommended must be a 0-based index into choices");
	}
	return { question, choices, recommended: params.recommended };
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

const ASK_USER_LABEL = "Ask User";

/** Collapsed one-liner vs expanded question+choices for the transcript row. */
class AskUserCallComponent implements Component {
	expanded = false;
	private collapsedLine = "";
	private expandedLines: string[] = [];

	setArgs(
		theme: Theme,
		args: { question?: string; choices?: string[]; allowFreeText?: boolean; recommended?: number } | undefined,
	): void {
		const label = theme.fg("toolTitle", theme.bold(ASK_USER_LABEL));
		const question = typeof args?.question === "string" ? args.question.replace(/\s+/g, " ").trim() : "";
		if (!question) {
			this.collapsedLine = `${label}  ${theme.fg("toolOutput", "...")}`;
			this.expandedLines = [this.collapsedLine];
			return;
		}
		this.collapsedLine = `${label}  ${theme.fg("text", question)}`;
		const lines = [`${label}  ${theme.fg("text", theme.bold(question))}`];
		const choices = Array.isArray(args?.choices) ? args!.choices!.filter((c) => typeof c === "string") : [];
		choices.forEach((choice, index) => {
			const recommended = index === args?.recommended ? ` ${theme.fg("dim", "(recommended)")}` : "";
			lines.push(`  ${theme.fg("dim", `${index + 1}.`)} ${theme.fg("muted", choice)}${recommended}`);
		});
		if (args?.allowFreeText) lines.push(`  ${theme.fg("dim", "(or type your own answer)")}`);
		this.expandedLines = lines;
	}

	render(width: number): string[] {
		if (this.expanded) return this.expandedLines.map((line) => truncateToWidth(line, width, "…"));
		return [truncateToWidth(this.collapsedLine, width, "…")];
	}

	invalidate(): void {}
}

/**
 * Bordered question selector in the fleet-panel visual language.
 * One instance per ask; `done` fires exactly once; dispose removes the abort listener.
 * The last row is an always-present free-text field when `allowFreeText` is on: no
 * "Other" option, just an input row under the choices.
 */
export class QuestionComponent implements Component {
	private selected = 0;
	private buffer = "";
	/** Cursor position inside the free-text draft, in characters. */
	private cursor = 0;
	private disposed = false;
	private readonly choices: readonly string[];
	private readonly freeTextRow: number;
	private readonly onAbort: () => void;
	private readonly question: string;
	private readonly allowFreeText: boolean;
	private readonly recommended: number | undefined;
	/** Dim annotation shown under the options when the sys1 ask gate disagrees
	 * with the agent's recommendation (re-ask after a hold). */
	private readonly sys1Line: string | undefined;
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
		choices: readonly string[],
		allowFreeText: boolean,
		done: (picked: string | undefined) => void,
		signal: AbortSignal | undefined,
		recommended?: number,
		sys1Line?: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.question = question;
		this.choices = choices;
		this.freeTextRow = allowFreeText ? choices.length : -1;
		this.allowFreeText = allowFreeText;
		this.recommended = recommended;
		this.sys1Line = sys1Line;
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
		const total = this.allowFreeText ? this.choices.length + 1 : this.choices.length;
		// Control keys before text: escape sequences must never land in the draft (the
		// old order turned "\x1b[A" into literal "[A"), and the selection keys work
		// from every row, including the free-text one.
		if (this.kb.matches(data, "tui.select.cancel")) {
			// On the free-text row with a draft, escape clears it and returns to the
			// choices; with no draft it cancels the whole question.
			if (this.selected === this.freeTextRow && this.buffer) {
				this.buffer = "";
				this.cursor = 0;
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			this.finish(undefined);
			return;
		}
		if (this.kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected + total - 1) % total;
			this.tui.requestRender();
			return;
		}
		if (this.kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % total;
			this.tui.requestRender();
			return;
		}
		// Escape sequences that are not selection movement are control input: ignore
		// them rather than appending them to the draft. On the free-text row the
		// horizontal pair moves the cursor inside the draft.
		if (data.startsWith("\x1b")) {
			if (this.selected === this.freeTextRow && this.kb.matches(data, "tui.editor.cursorLeft")) {
				this.cursor = Math.max(0, this.cursor - 1);
				this.tui.requestRender();
				return;
			}
			if (this.selected === this.freeTextRow && this.kb.matches(data, "tui.editor.cursorRight")) {
				this.cursor = Math.min(this.buffer.length, this.cursor + 1);
				this.tui.requestRender();
				return;
			}
			return;
		}
		if (data === "\t" && this.allowFreeText) {
			this.selected = this.freeTextRow;
			this.tui.requestRender();
			return;
		}
		// The free-text row is the last selection target. While it is focused, printable
		// keys edit the draft in place and backspace edits it too; other keys keep their
		// meanings. Printable keys on a choice row do nothing.
		if (this.selected === this.freeTextRow) {
			if (data === "\x7f" || data === "\b") {
				if (this.cursor > 0) {
					const chars = [...this.buffer];
					this.buffer = chars.slice(0, this.cursor - 1).join("") + chars.slice(this.cursor).join("");
					this.cursor -= 1;
				}
				this.tui.requestRender();
				return;
			}
			if ([...data].some((ch) => ch >= " " && ch !== "\x7f")) {
				const inserted = [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("");
				const chars = [...this.buffer];
				this.buffer =
					chars.slice(0, this.cursor).join("") + inserted + chars.slice(this.cursor).join("");
				this.cursor += [...inserted].length;
				this.tui.requestRender();
				return;
			}
		}
		if (this.kb.matches(data, "tui.select.confirm")) {
			if (this.selected === this.freeTextRow) {
				const text = this.buffer.trim();
				if (text) {
					this.finish(text);
					return;
				}
			} else {
				this.finish(this.choices[this.selected]);
				return;
			}
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
		for (const [index, option] of this.choices.entries()) {
			const marker = index === this.selected ? this.theme.fg("accent", "▸") : " ";
			const number = this.theme.fg("dim", `${index + 1}.`);
			const recommended = index === this.recommended ? ` ${this.theme.fg("dim", "(recommended)")}` : "";
			lines.push(this.padLine(`${marker} ${number} ${option}${recommended}`, width));
		}
		// The free-text row is always on when allowed: the field itself is the last
		// row, so the choices never disappear while the user types.
		if (this.allowFreeText) {
			const chars = [...this.buffer];
			const focused = this.selected === this.freeTextRow;
			// Row budget: borders (2), padLine spaces (2), the "❯ " prompt (2), and
			// the cursor block (1). Keep the tail so the cursor stays visible; a
			// cursor left of the window pins the window to it. Rendering never mutates
			// the draft: the whole buffer is kept and submitted even when only the
			// tail fits.
			const available = Math.max(0, width - 7);
			const start = Math.min(Math.max(0, chars.length - available), this.cursor);
			const shownText = chars.slice(start).join("") || this.theme.fg("dim", "type your answer…");
			const block = focused ? this.theme.fg("accent", "▊") : "";
			const offset = focused ? Math.max(0, this.cursor - start) : shownText.length;
			const shown = `${shownText.slice(0, offset)}${block}${shownText.slice(offset)}`;
			lines.push(this.padLine(`${this.theme.fg("accent", "❯")} ${shown}`, width));
		}
		if (this.sys1Line) lines.push(this.padLine("", width), this.padLine(this.theme.fg("dim", this.sys1Line), width));
		lines.push(
			this.padLine("", width),
			this.padLine(this.theme.fg("dim", this.selected === this.freeTextRow ? INPUT_HINT : this.allowFreeText ? QUESTION_HINT : QUESTION_HINT_PLAIN), width),
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
	recommended?: number,
	sys1Line?: string,
): Promise<AskUserResult> {
	notifyQuestionPending(ctx, question);
	const picked = await withAbort(
		ctx.ui.custom<string | undefined>(
			(tui, theme, kb, done) =>
				new QuestionComponent(tui, theme, kb, question, choices, allowFreeText, done, signal, recommended, sys1Line),
		),
		signal,
	);
	if (signal?.aborted || picked === undefined) return result("", true);
	return result(picked, false);
}

/** Ring the terminal so an unfocused pane gets noticed while the selector waits. */
function notifyQuestionPending(ctx: ExtensionContext, question: string): void {
	try {
		const channel = SettingsManager.create(ctx.cwd).getTerminalNotifications();
		if (channel !== "off") sendTerminalNotification(channel, `hummin: question - ${question}`);
	} catch {
		// Settings are unreadable in exotic setups; asking must keep working.
	}
}

export default function humminAsk(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question with 2-6 explicit choices and return the picked answer. Use when a decision is genuinely the user's to make (ambiguous scope, destructive action, missing requirement). Mark your preferred option with recommended (0-based index) so the UI labels it '(recommended)'. The user can also type their own answer on the free-text row (default on); set allowFreeText false to remove it. Cancelled means the user declined to answer.",
		promptSnippet: "ask_user: ask the user a multiple-choice question and return the answer",
		parameters: Type.Object({
			question: Type.String({ minLength: 1, maxLength: QUESTION_MAX, description: "The question to ask" }),
			choices: Type.Array(
				Type.String({ minLength: 1, maxLength: CHOICE_MAX }),
				{ minItems: CHOICES_MIN, maxItems: CHOICES_MAX, description: "The answer options" },
			),
			allowFreeText: Type.Optional(
				Type.Boolean({ description: "Offer a free-form answer typed on the free-text row (default true)" }),
			),
			recommended: Type.Optional(
				Type.Number({ description: "0-based index of the choice you recommend; shown as '(recommended)'" }),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const { question, choices, recommended } = validateAskParams(params);
			const allowFreeText = params.allowFreeText ?? true;
			signal?.throwIfAborted();
			if (ctx.mode !== "tui") {
				const fallback = choices[recommended ?? 0];
				return toolResult(result(fallback, false, "non-interactive: defaulted to recommended choice"));
			}
			// sys1 ask gate: when the model recommends an option, one System-1 read
			// checks that pick against the session's stated intent. A confident
			// disagreement holds the question once and steers the model; an unchanged
			// re-ask is shown annotated with both opinions. Everything else fails
			// open. No recommendation -> nothing to check.
			let sys1Line: string | undefined;
			if (recommended !== undefined) {
				const recommendedLabel = choices[recommended];
				const held = heldDecisionFor(question, Date.now());
				if (held) {
					clearHeldDecision(question);
					sys1Line = `sys1: engine favors "${held.enginePick}" (P=${held.p.toFixed(2)}) over the agent's recommendation`;
				} else {
					const hold = await sys1AskGateCheck({
						userTexts: extractUserTexts(ctx.sessionManager.getEntries()),
						question,
						choices,
						recommendedLabel,
						cwd: ctx.cwd,
					});
					signal?.throwIfAborted();
					if (hold) {
						rememberHeldDecision(question, hold.enginePick, hold.p, Date.now());
						return {
							content: [{ type: "text", text: askGateHoldReason(hold.enginePick, hold.p, recommendedLabel) }],
							details: { choice: "", cancelled: true, notice: "sys1 ask gate held the question once" },
						};
					}
				}
			}
			const out = await askInteractive(question, choices, allowFreeText, ctx, signal, recommended, sys1Line);
			if (sys1Line && !out.cancelled) {
				const annotation = sys1Line.replace("sys1: ", "sys1 ");
				return toolResult(result(out.choice, out.cancelled, out.notice ? `${out.notice}; ${annotation}` : annotation));
			}
			return toolResult(out);
		},

		renderCall(args, theme, context) {
			const component = (context.lastComponent as AskUserCallComponent | undefined) ?? new AskUserCallComponent();
			component.setArgs(theme, args as { question?: string; choices?: string[]; allowFreeText?: boolean });
			component.expanded = context.expanded;
			return component;
		},

		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const text = result.content.find((c) => c.type === "text")?.text ?? "error";
				return new Text(theme.fg("error", text.trim()), 0, 0);
			}
			const details = result.details as AskUserResult | undefined;
			if (!details || details.cancelled) {
				if (details?.notice?.startsWith("sys1 ask gate")) {
					return new Text(theme.fg("warning", "held by sys1 ask gate (steered back to the agent)"), 0, 0);
				}
				return new Text(theme.fg("dim", "cancelled"), 0, 0);
			}
			let line = `${theme.fg("success", "→")} ${theme.fg("accent", details.choice)}`;
			if (details.notice) line += ` ${theme.fg("dim", `(${details.notice})`)}`;
			return new Text(line, 0, 0);
		},
	});
}
