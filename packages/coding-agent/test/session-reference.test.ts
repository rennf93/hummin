import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import {
	buildSessionProjection,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import {
	buildSessionReferenceContent,
	extractFirstUserText,
	extractLastAssistantText,
	SESSION_REFERENCE_CUSTOM_TYPE,
} from "../src/core/session-reference.ts";

describe("session reference", () => {
	test("carry header records parentSession and the pointer persists as a custom_message entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-reference-"));
		const sm = SessionManager.create(dir, dir);
		sm.newSession({ parentSession: "/tmp/prev/old.jsonl" });
		sm.appendCustomMessageEntry(
			SESSION_REFERENCE_CUSTOM_TYPE,
			buildSessionReferenceContent({
				sessionFile: "/tmp/prev/old.jsonl",
				entryCount: 3,
				firstUserText: "fix the login bug",
				lastAssistantText: "patched auth.ts",
			}),
			false,
			{ entryCount: 3 },
		);

		const header = sm.getHeader();
		expect(header?.parentSession).toBe("/tmp/prev/old.jsonl");

		// The canonical entry type survives the round trip, so context edits can target it.
		const persisted = loadEntriesFromFile(sm.getSessionFile()!);
		const pointerEntry = persisted.find(
			(entry) =>
				entry.type === "custom_message" &&
				(entry as { customType?: string }).customType === SESSION_REFERENCE_CUSTOM_TYPE,
		);
		expect(pointerEntry).toBeDefined();

		const { messages } = buildSessionProjection(sm.getEntries(), sm.getLeafId());
		const pointer = messages.find(
			(message) => (message as { customType?: string }).customType === SESSION_REFERENCE_CUSTOM_TYPE,
		);
		expect(pointer).toBeDefined();
		expect((pointer as { display?: boolean }).display).toBe(false);
		expect(JSON.stringify((pointer as { content?: unknown }).content)).toContain("/tmp/prev/old.jsonl");
		expect(JSON.stringify((pointer as { content?: unknown }).content)).toContain("background reference only");
	});

	test("pointer content caps long texts and includes the focus note", () => {
		const long = "x".repeat(500);
		const content = buildSessionReferenceContent({
			sessionFile: "old.jsonl",
			entryCount: 9,
			firstUserText: long,
			lastAssistantText: long,
			note: long,
		});
		expect(content).toContain("old.jsonl (9 entries");
		expect(content).not.toContain("x".repeat(200));
		expect(content).toContain("Focus for this session:");
	});

	test("extraction pulls first user and last assistant text, skipping empties", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: "2026-11-17T00:00:00.000Z",
				message: { role: "user", content: "  hello\nworld  " } as AgentMessage,
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: "2026-11-17T00:01:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "all done" }] } as AgentMessage,
			},
			{
				type: "message",
				id: "3",
				parentId: "2",
				timestamp: "2026-11-17T00:02:00.000Z",
				message: { role: "user", content: "" } as AgentMessage,
			},
		];
		expect(extractFirstUserText(entries)).toBe("hello\nworld");
		expect(extractLastAssistantText(entries)).toBe("all done");
		expect(extractFirstUserText([])).toBeUndefined();
		expect(extractLastAssistantText([])).toBeUndefined();
	});
});
