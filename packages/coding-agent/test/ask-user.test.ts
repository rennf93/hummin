import { describe, expect, it } from "vitest";
import {
	askInteractive,
	buildOptions,
	CHOICE_MAX,
	CHOICES_MAX,
	CHOICES_MIN,
	FREE_TEXT_LABEL,
	INPUT_HINT,
	normalizeChoices,
	normalizeQuestion,
	QUESTION_HINT,
	QUESTION_MAX,
	QuestionComponent,
	validateAskParams,
} from "../extensions/hummin-ask.ts";

describe("ask_user helpers", () => {
	it("trims and truncates the question", () => {
		expect(normalizeQuestion("  Pick one  ")).toBe("Pick one");
		expect(normalizeQuestion("x".repeat(QUESTION_MAX + 50))).toHaveLength(QUESTION_MAX);
	});

	it("rejects empty questions", () => {
		expect(() => normalizeQuestion("")).toThrow();
		expect(() => normalizeQuestion("   ")).toThrow();
	});

	it("trims and truncates each choice", () => {
		const choices = normalizeChoices([" alpha ", "b".repeat(CHOICE_MAX + 10)]);
		expect(choices[0]).toBe("alpha");
		expect(choices[1]).toHaveLength(CHOICE_MAX);
	});

	it("rejects empty and duplicate choices", () => {
		expect(() => normalizeChoices(["a", "  "])).toThrow();
		expect(() => normalizeChoices(["a", "a"])).toThrow();
		expect(() => normalizeChoices(["a", "a", "b"])).toThrow();
	});

	it(`requires ${CHOICES_MIN}-${CHOICES_MAX} choices`, () => {
		expect(() => normalizeChoices(["only-one"])).toThrow();
		expect(() => normalizeChoices(Array.from({ length: CHOICES_MAX + 1 }, (_, i) => `c${i}`))).toThrow();
		expect(normalizeChoices(["a", "b"])).toEqual(["a", "b"]);
		expect(normalizeChoices(Array.from({ length: CHOICES_MAX }, (_, i) => `c${i}`))).toHaveLength(CHOICES_MAX);
	});

	it("appends the free-text escape hatch only when allowed", () => {
		expect(buildOptions(["a", "b"], false)).toEqual(["a", "b"]);
		const withFree = buildOptions(["a", "b"], true);
		expect(withFree).toEqual(["a", "b", FREE_TEXT_LABEL]);
		expect(withFree[withFree.length - 1]).toBe(FREE_TEXT_LABEL);
	});

	it("validates params in one pass", () => {
		const ok = validateAskParams({ question: "q", choices: ["a", "b"], allowFreeText: true });
		expect(ok).toEqual({ question: "q", choices: ["a", "b"] });
		expect(() => validateAskParams({ question: "q", choices: ["a", "a"] })).toThrow();
		expect(() => validateAskParams({ question: "", choices: ["a", "b"] })).toThrow();
	});

	it("validates the recommended index", () => {
		expect(validateAskParams({ question: "q", choices: ["a", "b"], recommended: 1 }).recommended).toBe(1);
		expect(() => validateAskParams({ question: "q", choices: ["a", "b"], recommended: 2 })).toThrow();
		expect(() => validateAskParams({ question: "q", choices: ["a", "b"], recommended: -1 })).toThrow();
		expect(() => validateAskParams({ question: "q", choices: ["a", "b"], recommended: 0.5 })).toThrow();
	});
});

// Minimal fakes matching the shapes hummin-ask consumes from pi-tui / ctx.ui.
const fakeTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};
const fakeKb = {
	matches: (data: string, action: string) => data === action,
};
const fakeTui = { requestRender: () => {} };

type CustomFactory = (tui: unknown, theme: unknown, kb: unknown, done: (picked: string | undefined) => void) => unknown;

/** Mock ctx.ui whose custom() records each call and resolves via respond(). */
function mockUi() {
	const customs: Array<(picked: string | undefined) => void> = [];
	const ui = {
		custom: (factory: CustomFactory) =>
			new Promise<string | undefined>((resolve) => {
				factory(fakeTui, fakeTheme, fakeKb, (picked) => resolve(picked));
				customs.push((picked) => resolve(picked));
			}),
		input: () => Promise.resolve(undefined),
	};
	return { ui, respond: (i: number, picked: string | undefined) => customs[i]?.(picked) };
}

const ctx = (ui: unknown) => ({ mode: "tui" as const, ui });

/** Keybindings fake that maps the real terminal sequences to select actions. */
const keyKb = {
	matches: (data: string, action: string) =>
		(action === "tui.select.confirm" && data === "\r") ||
		(action === "tui.select.cancel" && data === "\x1b") ||
		(action === "tui.select.up" && data === "\x1b[A") ||
		(action === "tui.select.down" && data === "\x1b[B"),
};

function question(allowFreeText: boolean, picked: (value: string | undefined) => void, recommended?: number) {
	const renders: string[][] = [];
	const renderNow = () => renders.push(component.render(80));
	const tui = { requestRender: () => renderNow() };
	const component = new QuestionComponent(
		tui as never,
		fakeTheme as never,
		keyKb as never,
		"Q",
		buildOptions(["a", "b"], allowFreeText),
		allowFreeText,
		picked,
		undefined,
		recommended,
	);
	renderNow();
	return { component, renders };
}

describe("ask_user inline free-text editing", () => {
	it("tab enters inline input, typed keys land in place, enter submits", () => {
		let picked: string | undefined;
		const { component, renders } = question(true, (value) => {
			picked = value;
		});
		component.handleInput("\t");
		component.handleInput("h");
		component.handleInput("i");
		const frame = renders.at(-1)!.join("\n");
		expect(frame).toContain("hi▊");
		expect(frame).toContain(INPUT_HINT);
		component.handleInput("\r");
		expect(picked).toBe("hi");
	});

	it("backspace edits and escape returns to the list without resolving", () => {
		let picked: string | undefined;
		const { component, renders } = question(true, (value) => {
			picked = value;
		});
		component.handleInput("\t");
		component.handleInput("hi");
		component.handleInput("\x7f");
		expect(renders.at(-1)!.join("\n")).toContain("h▊");
		component.handleInput("\x1b");
		expect(picked).toBeUndefined();
		const list = renders.at(-1)!.join("\n");
		expect(list).toContain(FREE_TEXT_LABEL);
		expect(list).toContain(QUESTION_HINT);
		component.handleInput("\r"); // first option, list mode again
		expect(picked).toBe("a");
	});

	it("confirming Other... switches to inline input instead of a second screen", () => {
		let picked: string | undefined;
		const { component, renders } = question(true, (value) => {
			picked = value;
		});
		component.handleInput("\x1b[B"); // down to b
		component.handleInput("\x1b[B"); // down to Other...
		component.handleInput("\r");
		expect(renders.at(-1)!.join("\n")).toContain("type your answer…");
		component.handleInput("maybe b");
		component.handleInput("\r");
		expect(picked).toBe("maybe b");
	});

	it("empty inline input does not submit", () => {
		let picked: string | undefined;
		const { component } = question(true, (value) => {
			picked = value;
		});
		component.handleInput("\t");
		component.handleInput("\r");
		expect(picked).toBeUndefined();
	});

	it("renders the recommended marker on the marked choice", () => {
		const { renders } = question(true, () => {}, 1);
		const frame = renders[0]!.join("\n");
		expect(frame).toContain("b (recommended)");
		expect(frame).not.toContain("a (recommended)");
	});

	it("escape in list mode cancels the whole question", () => {
		let picked: string | undefined | "unset" = "unset";
		const { component } = question(false, (value) => {
			picked = value;
		});
		component.handleInput("\x1b");
		expect(picked).toBeUndefined();
	});
});

describe("ask_user lifecycle", () => {
	it("renders a bordered fleet-style panel", () => {
		let component: { render: (width: number) => string[] } | undefined;
		const mui = {
			custom: (factory: CustomFactory) => {
				let resolve: (p?: string) => void = () => {};
				const promise = new Promise<string | undefined>((r) => {
					resolve = r;
				});
				component = factory(fakeTui, fakeTheme, fakeKb, resolve) as { render: (w: number) => string[] };
				return promise;
			},
			input: () => Promise.resolve(undefined),
		};
		void askInteractive("Pick one", ["a", "b"], true, ctx(mui) as never, undefined);
		expect(component).toBeDefined();
		const lines = component!.render(80);
		expect(lines[0].startsWith("╭")).toBe(true);
		expect(lines.at(-1)!.startsWith("╰")).toBe(true);
		const joined = lines.join("\n");
		expect(joined).toContain("Pick one");
		expect(joined).toContain("1. a");
		expect(joined).toContain("2. b");
		expect(joined).toContain(FREE_TEXT_LABEL);
		expect(joined).toContain(QUESTION_HINT);
	});

	it("two sequential asks each resolve cleanly (hang regression)", async () => {
		const { ui, respond } = mockUi();
		const p1 = askInteractive("Q1", ["a", "b"], false, ctx(ui) as never, undefined);
		await Promise.resolve();
		respond(0, "a");
		await expect(p1).resolves.toEqual({ choice: "a", cancelled: false });

		const p2 = askInteractive("Q2", ["x", "y"], false, ctx(ui) as never, undefined);
		await Promise.resolve();
		respond(1, "y");
		await expect(p2).resolves.toEqual({ choice: "y", cancelled: false });
	});

	it("abort resolves a pending ask as cancelled", async () => {
		const { ui, respond } = mockUi();
		const controller = new AbortController();
		const p = askInteractive("Q", ["a", "b"], false, ctx(ui) as never, controller.signal);
		await Promise.resolve();
		controller.abort();
		await expect(p).resolves.toEqual({ choice: "", cancelled: true });
		respond(0, "a"); // late answer must not un-resolve or throw
		await expect(p).resolves.toEqual({ choice: "", cancelled: true });
	});

	it("a pending ask resolves cancelled when the host-side custom promise resolves undefined", async () => {
		const controllers: AbortController[] = [];
		const mui = {
			custom: (factory: (t: unknown, th: unknown, kb: unknown, done: (p?: string) => void) => unknown) => {
				const controller = new AbortController();
				controllers.push(controller);
				let resolve: (p?: string) => void = () => {};
				const promise = new Promise<string | undefined>((r) => {
					resolve = r;
				});
				factory(fakeTui, fakeTheme, fakeKb, resolve);
				controller.signal.addEventListener("abort", () => resolve(undefined));
				return promise;
			},
			input: () => Promise.resolve(undefined),
		};
		const controller = new AbortController();
		const p = askInteractive("Q", ["a", "b"], false, ctx(mui) as never, controller.signal);
		await Promise.resolve();
		controller.abort();
		await expect(p).resolves.toEqual({ choice: "", cancelled: true });
	});
});
