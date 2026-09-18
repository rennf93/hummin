import { describe, expect, it } from "vitest";
import {
	buildOptions,
	CHOICE_MAX,
	CHOICES_MAX,
	CHOICES_MIN,
	FREE_TEXT_LABEL,
	normalizeChoices,
	normalizeQuestion,
	QUESTION_MAX,
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
});
