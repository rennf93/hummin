import { describe, expect, it } from "vitest";
import { formatTodoStatus, type Todo } from "../extensions/hummin-todos.ts";

function todo(text: string, status: Todo["status"]): Todo {
	return { text, status };
}

describe("formatTodoStatus", () => {
	it("returns undefined when there is no list", () => {
		expect(formatTodoStatus([])).toBeUndefined();
	});

	it("shows done counts and the current item", () => {
		const todos = [todo("first", "completed"), todo("second", "in_progress"), todo("third", "pending")];
		expect(formatTodoStatus(todos)).toBe("TODOs 1/3 · second");
	});

	it("trims the current item text", () => {
		const todos = [todo("  spaced item  ", "in_progress")];
		expect(formatTodoStatus(todos)).toBe("TODOs 0/1 · spaced item");
	});

	it("omits the current item when nothing is in progress", () => {
		const todos = [todo("a", "completed"), todo("b", "completed")];
		expect(formatTodoStatus(todos)).toBe("TODOs 2/2");
	});

	it("omits the current item part when the in-progress text is empty", () => {
		const todos = [todo("   ", "in_progress")];
		expect(formatTodoStatus(todos)).toBe("TODOs 0/1");
	});

	it("truncates very long current item text", () => {
		const long = "x".repeat(100);
		const result = formatTodoStatus([todo(long, "in_progress")]);
		expect(result).toBe(`TODOs 0/1 · ${"x".repeat(59)}…`);
		expect(result?.length).toBeLessThan(long.length);
	});
});
