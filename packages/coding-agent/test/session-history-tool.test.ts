import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createSessionsToolDefinition, SESSIONS_TOOL_NAME } from "../src/extensions/session-history/tool.ts";

type FixtureLine = { type: string; message?: unknown; customType?: string; content?: unknown };

function writeSession(dir: string, name: string, lines: FixtureLine[], parent?: string): string {
	const file = join(dir, name);
	const header = {
		type: "session",
		id: name.replace(/\.jsonl$/, ""),
		timestamp: "2026-11-17T00:00:00.000Z",
		cwd: dir,
		...(parent ? { parentSession: parent } : {}),
	};
	const body = lines.map((line, index) => ({
		id: `${name}-${index}`,
		parentId: index === 0 ? header.id : `${name}-${index - 1}`,
		timestamp: "2026-11-17T00:01:00.000Z",
		...line,
	}));
	writeFileSync(file, [JSON.stringify(header), ...body.map((entry) => JSON.stringify(entry))].join("\n") + "\n");
	return file;
}

function userMessage(text: string): FixtureLine {
	return { type: "message", message: { role: "user", content: text } };
}

function assistantMessage(text: string): FixtureLine {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function ctxFor(dir: string, current: string): ExtensionToolContext {
	return {
		sessionManager: {
			getSessionDir: () => dir,
			getSessionFile: () => current,
		},
	} as unknown as ExtensionToolContext;
}

/** Pin deterministic whole-millisecond mtimes: APFS write mtimes carry sub-ms precision, while utimesSync truncates to ms. */
function setMtimes(dir: string, order: Array<[string, number]>): void {
	for (const [name, mtimeMs] of order) {
		utimesSync(join(dir, name), new Date(mtimeMs), new Date(mtimeMs));
	}
}

async function run(
	action: "list" | "search" | "read",
	ctx: ExtensionToolContext,
	params: Record<string, unknown> = {},
) {
	const definition = createSessionsToolDefinition();
	return definition.execute("call-1", { action, ...params } as never, undefined, undefined, ctx);
}

describe("sessions tool", () => {
	test("metadata and schema basics", () => {
		const definition = createSessionsToolDefinition();
		expect(definition.name).toBe(SESSIONS_TOOL_NAME);
		expect(definition.defaultActive).toBe(false);
	});

	test("list excludes the current transcript and summarizes the others, newest first", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sessions-tool-list-"));
		writeSession(dir, "old-a.jsonl", [userMessage("investigate the flurbish regression"), assistantMessage("on it")]);
		writeSession(dir, "old-b.jsonl", [userMessage("write the release notes")]);
		const current = writeSession(dir, "current.jsonl", [userMessage("fresh start")]);
		setMtimes(dir, [
			["old-a.jsonl", 1000],
			["old-b.jsonl", 2000],
			["current.jsonl", 3000],
		]);

		const result = await run("list", ctxFor(dir, current));
		expect(result.details).toMatchObject({ action: "list", count: 2 });
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("current.jsonl");
		const bIndex = text.indexOf("old-b.jsonl");
		const aIndex = text.indexOf("old-a.jsonl");
		expect(bIndex).toBeGreaterThanOrEqual(0);
		expect(aIndex).toBeGreaterThan(bIndex);
		expect(text).toContain("flurbish");
	});

	test("search finds matches across transcripts with capped snippets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sessions-tool-search-"));
		writeSession(dir, "old-a.jsonl", [userMessage("the flurbish token rotates hourly"), assistantMessage("noted")]);
		writeSession(dir, "old-b.jsonl", [userMessage("nothing relevant here")]);
		const current = writeSession(dir, "current.jsonl", [userMessage("flurbish in current too")]);

		const result = await run("search", ctxFor(dir, current), { query: "flurbish" });
		expect(result.details).toMatchObject({ action: "search" });
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("old-a.jsonl [0]");
		expect(text).not.toContain("current.jsonl");
		expect(text).not.toContain("old-b.jsonl");
	});

	test("search honors an explicit session file and read reports missing files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sessions-tool-explicit-"));
		writeSession(dir, "old-a.jsonl", [userMessage("the flurbish token rotates hourly")]);
		writeSession(dir, "old-b.jsonl", [userMessage("nothing relevant here")]);
		const current = writeSession(dir, "current.jsonl", [userMessage("current")]);

		const scoped = await run("search", ctxFor(dir, current), { query: "flurbish", session: "old-b.jsonl" });
		const scopedText = scoped.content[0].type === "text" ? scoped.content[0].text : "";
		expect(scopedText).toContain("No matches");
		expect(scopedText).toContain("1 transcript(s)");
		expect(scopedText).not.toContain("old-a.jsonl");

		const missing = await run("read", ctxFor(dir, current), { session: "gone.jsonl", start: 0, end: 3 });
		const missingText = missing.content[0].type === "text" ? missing.content[0].text : "";
		expect(missingText).toContain("Unreadable or missing transcript");
	});

	test("search without a query throws", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sessions-tool-args-"));
		const current = writeSession(dir, "current.jsonl", [userMessage("hi")]);
		await expect(run("search", ctxFor(dir, current))).rejects.toThrow("query");
	});

	test("read renders a span with per-entry caps and supports explicit files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sessions-tool-read-"));
		const long = "y".repeat(1000);
		writeSession(dir, "old-a.jsonl", [userMessage("short one"), assistantMessage(long)]);
		const current = writeSession(dir, "current.jsonl", [userMessage("current session")]);

		const result = await run("read", ctxFor(dir, current), { session: "old-a.jsonl", start: 0, end: 2 });
		expect(result.details).toMatchObject({ action: "read", count: 2 });
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("[0] user: short one");
		expect(text).toContain("[1] assistant:");
		expect(text).toContain("...");
		expect(text).not.toContain("y".repeat(500));
	});

	test("read defaults to the newest other transcript and reports missing spans", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sessions-tool-default-"));
		mkdirSync(dir, { recursive: true });
		writeSession(dir, "older.jsonl", [userMessage("older conversation")]);
		const current = writeSession(dir, "current.jsonl", [userMessage("current session")]);
		setMtimes(dir, [
			["older.jsonl", 2000],
			["current.jsonl", 1000],
		]);

		const result = await run("read", ctxFor(dir, current), { start: 5, end: 9 });
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("older.jsonl");
		expect(text).toContain("past the end of older.jsonl (1 entry)");
	});
});
