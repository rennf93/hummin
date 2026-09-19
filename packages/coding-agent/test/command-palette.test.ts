import {
	commandGroupHeader,
	type GroupableCommand,
	groupOrderedCommands,
	UNGROUPED_COMMAND_CATEGORY,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

function names(items: GroupableCommand[]): string[] {
	return items.map((item) => item.name);
}

const fixtures: GroupableCommand[] = [
	{ name: "settings", category: "Settings" },
	{ name: "share", category: "Tools" },
	{ name: "tree", category: "Session" },
	{ name: "skill:writer" },
	{ name: "copy", category: "Tools" },
	{ name: "model", category: "Models" },
];

describe("commandGroupHeader", () => {
	it("returns the category when set", () => {
		expect(commandGroupHeader("Models")).toBe("Models");
	});

	it("maps ungrouped and blank categories to the Commands header", () => {
		expect(commandGroupHeader(undefined)).toBe(UNGROUPED_COMMAND_CATEGORY);
		expect(commandGroupHeader("")).toBe(UNGROUPED_COMMAND_CATEGORY);
		expect(commandGroupHeader("   ")).toBe(UNGROUPED_COMMAND_CATEGORY);
	});
});

describe("groupOrderedCommands", () => {
	it("groups into category runs with ungrouped last", () => {
		const ordered = groupOrderedCommands(fixtures, "");
		expect(names(ordered)).toEqual([
			"model", // Models
			"tree", // Session
			"settings", // Settings
			"share", // Tools (alphabetical within group preserved)
			"copy",
			"skill:writer", // Commands, last
		]);
		// Group headers form contiguous runs.
		const headers = ordered.map((item) => commandGroupHeader(item.category));
		const runs = headers.filter((header, index) => index === 0 || header !== headers[index - 1]);
		expect(runs).toEqual(["Models", "Session", "Settings", "Tools", "Commands"]);
	});

	it("sorts groups alphabetically by header with Commands last", () => {
		const ordered = groupOrderedCommands(fixtures, "");
		const headers = ordered.map((item) => commandGroupHeader(item.category));
		expect(headers[headers.length - 1]).toBe(UNGROUPED_COMMAND_CATEGORY);
		const distinct = [...new Set(headers.slice(0, -1))];
		expect(distinct).toEqual([...distinct].sort((a, b) => a.localeCompare(b)));
	});

	it("promotes the exact match's group first", () => {
		const ordered = groupOrderedCommands(fixtures, "share");
		expect(names(ordered)[0]).toBe("share");
		const headers = ordered.map((item) => commandGroupHeader(item.category));
		expect(headers[0]).toBe("Tools");
		// Ungrouped still last among the remaining groups.
		expect(headers[headers.length - 1]).toBe(UNGROUPED_COMMAND_CATEGORY);
	});

	it("is stable within a group when no prefix is given", () => {
		const items: GroupableCommand[] = [
			{ name: "b", category: "S" },
			{ name: "a", category: "S" },
		];
		expect(names(groupOrderedCommands(items, ""))).toEqual(["b", "a"]);
	});

	it("handles empty input", () => {
		expect(groupOrderedCommands([], "")).toEqual([]);
	});
});
