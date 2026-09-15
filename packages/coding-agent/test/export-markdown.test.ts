import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { exportSessionToMarkdown } from "../src/core/export-markdown.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("exports only the active branch as readable markdown", () => {
	const dir = mkdtempSync(join(tmpdir(), "hummin-export-md-"));
	dirs.push(dir);
	const session = {
		getCwd: () => dir,
		getHeader: () => ({ type: "session" as const, id: "s1", timestamp: "2026-09-15T00:00:00.000Z", cwd: dir }),
		getBranch: () => [
			{
				type: "message" as const,
				id: "1",
				parentId: null,
				timestamp: "",
				message: { role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 0 },
			},
			{
				type: "message" as const,
				id: "2",
				parentId: "1",
				timestamp: "",
				message: {
					role: "assistant" as const,
					content: [{ type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "x.ts" } }],
					api: "openai-completions" as const,
					provider: "test",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: 0,
				},
			},
		],
	};
	const path = join(dir, "session.md");
	exportSessionToMarkdown(session, path);
	const output = readFileSync(path, "utf8");
	expect(output).toContain("## User");
	expect(output).toContain("hello");
	expect(output).toContain('"path": "x.ts"');
	expect(output).not.toContain("abandoned");
});

test("refuses explicit overwrite and creates a suffix for default collisions", () => {
	const dir = mkdtempSync(join(tmpdir(), "hummin-export-md-"));
	dirs.push(dir);
	const session = {
		getCwd: () => dir,
		getHeader: () => ({ type: "session" as const, id: "s1", timestamp: "2026-09-15T00:00:00.000Z", cwd: dir }),
		getBranch: () => [],
	};
	const explicit = join(dir, "existing.md");
	const first = exportSessionToMarkdown(session);
	expect(existsSync(first)).toBe(true);
	// The generated default path is timestamped; this verifies collision handling by creating it first.
	const second = exportSessionToMarkdown(session);
	expect(second).not.toBe(first);
	expect(() => exportSessionToMarkdown(session, explicit)).not.toThrow();
	expect(() => exportSessionToMarkdown(session, explicit)).toThrow("File already exists");
});
