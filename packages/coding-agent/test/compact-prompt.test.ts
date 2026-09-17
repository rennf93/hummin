import type { TSchema } from "typebox";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { compactToolDescription, stripSchemaDescriptions } from "../src/core/compact-prompt.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("compactToolDescription", () => {
	it("keeps only the first paragraph", () => {
		const description =
			"Execute a bash command in the current working directory.\n\nReturns combined stdout and stderr.";
		expect(compactToolDescription(description)).toBe("Execute a bash command in the current working directory.");
	});

	it("caps long first paragraphs at a sentence boundary", () => {
		const sentence = "Execute a bash command in the current working directory. ";
		const description = sentence.repeat(20).trim();
		const compact = compactToolDescription(description);
		expect(compact.length).toBeLessThanOrEqual(240);
		expect(compact.endsWith(".")).toBe(true);
		expect(compact.startsWith("Execute a bash command")).toBe(true);
	});

	it("returns short descriptions unchanged", () => {
		expect(compactToolDescription("Read a file.")).toBe("Read a file.");
	});
});

describe("stripSchemaDescriptions", () => {
	it("removes description keys while keeping structure", () => {
		const schema = Type.Object(
			{
				path: Type.String({ description: "Path to the file" }),
				limit: Type.Optional(Type.Number({ description: "Max lines" })),
				mode: Type.Union([Type.Literal("a"), Type.Literal("b")], { description: "Mode" }),
			},
			{ description: "Input schema" },
		);
		const stripped: TSchema = stripSchemaDescriptions(schema) as TSchema;
		const json = JSON.parse(JSON.stringify(stripped));
		expect(JSON.stringify(json)).not.toContain("description");
		expect(json.properties.path.type).toBe("string");
		expect(json.properties.mode.anyOf).toHaveLength(2);
	});

	it("handles nested arrays and objects", () => {
		const schema = Type.Object({ items: Type.Array(Type.Object({ name: Type.String({ description: "x" }) })) });
		const json = JSON.parse(JSON.stringify(stripSchemaDescriptions(schema)));
		expect(JSON.stringify(json)).not.toContain("description");
		expect(json.properties.items.type).toBe("array");
	});
});

describe("buildSystemPrompt compact mode", () => {
	const base = {
		cwd: "/tmp/project",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read a file", bash: "Run bash" },
	};

	it("default mode includes the full docs guidance block", () => {
		const prompt = buildSystemPrompt(base);
		expect(prompt).toContain("hummin documentation (read only when the user asks about hummin itself");
		expect(prompt).toContain("- Additional docs:");
	});

	it("compact mode shrinks the docs block to a short pointer", () => {
		const prompt = buildSystemPrompt({ ...base, compact: true });
		expect(prompt).toContain("hummin docs (only if the user asks about hummin itself)");
		expect(prompt).not.toContain("- Additional docs:");
	});
});
