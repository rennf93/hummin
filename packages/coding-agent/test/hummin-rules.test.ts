import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import humminRulesExtension, {
	bashCommandPaths,
	buildFirstTurnMessage,
	inputPaths,
	loadRules,
	parseFrontmatter,
	pathMatchesRule,
	ruleMessage,
} from "../extensions/hummin-rules.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-rules-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

it("parses frontmatter variants: inline array, block list, bare scalar, no frontmatter", () => {
	const inline = parseFrontmatter('---\npaths: ["src/**/*.ts", "*.md"]\ndescription: inline\n---\nbody text');
	expect(inline.paths).toEqual(["src/**/*.ts", "*.md"]);
	expect(inline.description).toBe("inline");
	expect(inline.body).toBe("body text");

	const block = parseFrontmatter("---\npaths:\n  - docs/*.md\n  - guides/**\ndescription: block\n---\nbody");
	expect(block.paths).toEqual(["docs/*.md", "guides/**"]);

	const bare = parseFrontmatter("---\ndescription: quoted\n---\nbody");
	expect(bare.paths).toEqual([]);
	expect(bare.description).toBe("quoted");

	const none = parseFrontmatter("just body");
	expect(none.paths).toEqual([]);
	expect(none.body).toBe("just body");
});

it("loads rules from a directory and skips unreadable/non-md entries", () => {
	const rulesDir = join(directory, CONFIG_DIR_NAME, "rules");
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(
		join(rulesDir, "ts-style.md"),
		'---\npaths: ["src/**/*.ts"]\ndescription: TS style\n---\nUse explicit types.',
	);
	writeFileSync(join(rulesDir, "always.md"), "Always apply this.");
	writeFileSync(join(rulesDir, "notes.txt"), "ignored");
	const rules = loadRules(rulesDir);
	expect(rules.map((rule) => rule.name).sort()).toEqual(["always", "ts-style"]);
});

it("matches globs Claude-Code-style: slashless patterns hit any depth", () => {
	const rule = { name: "r", paths: ["src/**/*.ts", "*.md"], description: "", body: "" };
	expect(pathMatchesRule(rule, "src/core/deep/file.ts", directory)).toBe(true);
	expect(pathMatchesRule(rule, "src/file.tsx", directory)).toBe(false);
	expect(pathMatchesRule(rule, "README.md", directory)).toBe(true);
	expect(pathMatchesRule(rule, join(directory, "docs/nested/GUIDE.md"), directory)).toBe(true);
	expect(pathMatchesRule(rule, "package.json", directory)).toBe(false);
});

it("always-apply rules go in full, path rules only as a catalog", () => {
	const message = buildFirstTurnMessage([
		{ name: "always", paths: [], description: "", body: "Always apply this." },
		{ name: "ts-style", paths: ["src/**/*.ts"], description: "TS style", body: "Use explicit types." },
	]);
	expect(message).toContain("Always apply this.");
	expect(message).not.toContain("Use explicit types.");
	expect(message).toContain("ts-style");
	expect(message).toContain("src/**/*.ts");
	expect(buildFirstTurnMessage([{ name: "solo", paths: ["x"], description: "", body: "b" }])).toContain("solo");
	expect(buildFirstTurnMessage([])).toBeUndefined();
});

it("extracts only string path inputs; empty/missing path is ignored", () => {
	expect(inputPaths({ path: "src/a.ts" })).toEqual(["src/a.ts"]);
	expect(inputPaths({ path: 42 })).toEqual([]);
	expect(inputPaths({})).toEqual([]);
	expect(inputPaths({ command: "rm -rf src/a.ts" })).toEqual([]);
});

it("renders rule messages with scope and body", () => {
	expect(ruleMessage({ name: "always", paths: [], description: "", body: "Body." })).toBe("[Rule: always]\nBody.");
	expect(ruleMessage({ name: "r", paths: ["a", "b"], description: "", body: "Body." })).toBe(
		"[Rule: r] (paths: a, b)\nBody.",
	);
});

it("extracts path-like tokens from bash commands", () => {
	expect(bashCommandPaths("cat src/foo.ts")).toEqual(["src/foo.ts"]);
	expect(bashCommandPaths('cat "src/foo.ts"')).toEqual(["src/foo.ts"]);
	expect(bashCommandPaths("cat 'src/foo.ts'")).toEqual(["src/foo.ts"]);
	expect(bashCommandPaths("sh ./test.sh --verbose")).toEqual(["./test.sh"]);
	expect(bashCommandPaths("node build/script.js")).toEqual(["build/script.js"]);
	// Flag values are kept as candidates; only the flag token itself is dropped.
	expect(bashCommandPaths("grep -e foo.md src/")).toEqual(["foo.md", "src/"]);
	expect(bashCommandPaths("sort > out.txt")).toEqual(["out.txt"]);
});

it("bash token extraction: empty commands, bare words, and redirects yield no paths", () => {
	expect(bashCommandPaths("")).toEqual([]);
	expect(bashCommandPaths("make test")).toEqual([]);
	expect(bashCommandPaths("npm run check -- --fix")).toEqual([]);
	expect(bashCommandPaths("ls 2>&1")).toEqual([]);
	expect(bashCommandPaths("sort 2>/dev/null")).toEqual([]);
	// A dotted token needs a non-empty stem before the dot.
	expect(bashCommandPaths("touch .gitignore foo.ts")).toEqual(["foo.ts"]);
});

it("delivers a path-scoped rule once on the first matching bash command", async () => {
	const rulesDir = join(directory, CONFIG_DIR_NAME, "rules");
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(
		join(rulesDir, "ts-style.md"),
		'---\npaths: ["src/**/*.ts"]\ndescription: TS style\n---\nUse explicit types.',
	);
	const toolCallHandlers: Array<(event: ToolCallEvent, ctx: ExtensionContext) => unknown> = [];
	const messages: Array<{ customType: string; content: unknown; deliverAs?: string }> = [];
	const api = {
		on: (event: string, handler: (e: ToolCallEvent, ctx: ExtensionContext) => unknown) => {
			if (event === "tool_call") toolCallHandlers.push(handler);
			return () => undefined;
		},
		appendEntry: () => undefined,
		sendMessage: (message: { customType: string; content: unknown }, options?: { deliverAs?: string }) => {
			messages.push({ customType: message.customType, content: message.content, deliverAs: options?.deliverAs });
			return undefined;
		},
	} as unknown as ExtensionAPI;
	await humminRulesExtension(api);
	const ctx = { cwd: directory } as unknown as ExtensionContext;
	const callBash = (command: string): void => {
		const event: ToolCallEvent = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } };
		for (const handler of toolCallHandlers) handler(event, ctx);
	};
	callBash("make test");
	expect(messages).toEqual([]);
	callBash('cat "src/a.ts"');
	expect(messages).toEqual([
		{
			customType: "hummin-rules",
			content: "[Rule: ts-style] (paths: src/**/*.ts)\nUse explicit types.",
			deliverAs: "steer",
		},
	]);
	callBash("cat src/b.ts");
	expect(messages).toHaveLength(1);
});
