import { describe, expect, test } from "vitest";
import {
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	DEFAULT_SELECTED_TOOLS,
} from "../src/core/tools/index.ts";

describe("default tool loadout", () => {
	test("includes grep in the default selection and keeps find and ls opt-in", () => {
		expect(DEFAULT_SELECTED_TOOLS).toEqual(["read", "bash", "edit", "write", "grep"]);
	});

	test("createCodingToolDefinitions mirrors the default loadout", () => {
		expect(createCodingToolDefinitions("/tmp").map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
		]);
	});

	test("createCodingTools mirrors the default loadout", () => {
		expect(createCodingTools("/tmp").map((tool) => tool.name)).toEqual(DEFAULT_SELECTED_TOOLS);
	});

	test("the read-only loadout is unchanged by the grep default", () => {
		expect(createReadOnlyToolDefinitions("/tmp").map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
	});
});
