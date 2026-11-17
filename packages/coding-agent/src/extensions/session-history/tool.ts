/**
 * `sessions`: bounded lookup over past session transcripts for this project's session directory.
 *
 * The tool is registered inactive and armed by the extension when a session starts with a
 * `previousSessionFile` (after `/carry`, `/clear`, `/fork`, or `/resume`), which is exactly when
 * looking back is useful. Outputs are capped so a lookup costs tokens, not a transcript dump:
 * prefer `search` over `read`, and keep `read` spans narrow. Entry indices are file order, which
 * interleaves abandoned branches; each line carries its index so spans can be widened on demand.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { parseSessionEntries, type SessionEntry } from "../../core/session-manager.ts";
import { messageText } from "../../core/session-reference.ts";

export const SESSIONS_TOOL_NAME = "sessions";

const LIST_LIMIT = 10;
const SEARCH_FILE_LIMIT = 50;
const SEARCH_MATCH_LIMIT = 8;
const SEARCH_SNIPPET_CHARS = 200;
const READ_DEFAULT_SPAN = 30;
const READ_ENTRY_CHARS = 400;
const READ_TOTAL_CHARS = 8000;
const FIRST_PROMPT_CHARS = 80;

export interface SessionsToolDetails {
	action: "list" | "search" | "read";
	/** Transcript the action concentrated on, when one applies. */
	file?: string;
	/** Entries or matches returned. */
	count?: number;
	/** Files skipped because they could not be parsed. */
	skipped?: number;
}

export const sessionsSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("read")], {
		description:
			"list: recent transcripts with first-prompt summaries. search: find entries matching a query. read: render a span of entries.",
	}),
	query: Type.Optional(
		Type.String({ description: "search: case-insensitive substring to find. Required for search." }),
	),
	session: Type.Optional(
		Type.String({
			description:
				"Transcript file name in the session dir, or an absolute path. Defaults: newest other transcript for read; the newest 50 transcripts for search.",
		}),
	),
	start: Type.Optional(Type.Number({ description: "read: first entry index (0-based, file order). Default 0." })),
	end: Type.Optional(Type.Number({ description: `read: exclusive end index. Default start + ${READ_DEFAULT_SPAN}.` })),
});

interface SessionFileRef {
	file: string;
	mtimeMs: number;
}

function sessionFiles(dir: string): SessionFileRef[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const refs: SessionFileRef[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			refs.push({ file: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs });
		} catch {
			// Vanished between readdir and stat: skip.
		}
	}
	return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Entries of a transcript in file order (header dropped, indices stable across calls). Parsed
 * non-mutatingly: `loadEntriesFromFile` repairs files that lack a trailing newline, and a
 * read-only lookup must not write to arbitrary paths.
 */
function loadEntries(file: string): SessionEntry[] {
	return parseSessionEntries(readFileSync(file, "utf8")).filter(
		(entry): entry is SessionEntry => entry.type !== "session",
	);
}

function resolveSession(ref: string | undefined, dir: string, candidates: SessionFileRef[]): string | undefined {
	if (!ref) return candidates[0]?.file;
	if (isAbsolute(ref)) return ref;
	return join(dir, ref);
}

function entryText(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message;
		const text = messageText(message);
		const tool = "toolName" in message && typeof message.toolName === "string" ? ` (${message.toolName})` : "";
		return `${message.role}${tool}: ${text}`;
	}
	if (entry.type === "custom_message") {
		return `note (${entry.customType}): ${messageText({ role: "custom", content: entry.content })}`;
	}
	if (entry.type === "compaction") return `[compaction boundary; earlier history summarized]`;
	if (entry.type === "branch_summary") return `[branch summary of an abandoned branch]`;
	return "";
}

function clip(text: string, cap: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap - 1)}...` : flat;
}

function renderEntry(index: number, entry: SessionEntry): string | undefined {
	const text = entryText(entry);
	if (!text) return undefined;
	return `[${index}] ${clip(text, READ_ENTRY_CHARS)}`;
}

function firstPrompt(entries: SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			const text = clip(messageText(entry.message), FIRST_PROMPT_CHARS);
			if (text) return text;
		}
	}
	return undefined;
}

function listSessions(dir: string, currentFile: string | undefined): { text: string; details: SessionsToolDetails } {
	const others = sessionFiles(dir)
		.filter((ref) => ref.file !== currentFile)
		.slice(0, LIST_LIMIT);
	if (others.length === 0) {
		return { text: "No other session transcripts found for this project.", details: { action: "list", count: 0 } };
	}
	const lines: string[] = [];
	let skipped = 0;
	for (const ref of others) {
		try {
			const entries = loadEntries(ref.file);
			const prompt = firstPrompt(entries);
			lines.push(`${basename(ref.file)} - ${entries.length} entries${prompt ? ` - began: "${prompt}"` : ""}`);
		} catch {
			skipped++;
		}
	}
	const text = lines.length > 0 ? lines.join("\n") : "No readable session transcripts found.";
	return {
		text: skipped > 0 ? `${text}\n(${skipped} unreadable skipped)` : text,
		details: { action: "list", count: lines.length, skipped },
	};
}

function searchSessions(
	dir: string,
	currentFile: string | undefined,
	query: string,
	sessionRef: string | undefined,
	signal: AbortSignal | undefined,
): { text: string; details: SessionsToolDetails } {
	const lowered = query.toLowerCase();
	const files = (
		sessionRef
			? [{ file: resolveSession(sessionRef, dir, sessionFiles(dir)), mtimeMs: 0 } as SessionFileRef]
			: sessionFiles(dir)
					.filter((ref) => ref.file !== currentFile)
					.slice(0, SEARCH_FILE_LIMIT)
	).filter((ref): ref is SessionFileRef => typeof ref.file === "string");
	const matches: string[] = [];
	let skipped = 0;
	let count = 0;
	for (const ref of files) {
		if (count >= SEARCH_MATCH_LIMIT) break;
		if (signal?.aborted) throw new Error("aborted");
		let entries: SessionEntry[];
		try {
			entries = loadEntries(ref.file);
		} catch {
			skipped++;
			continue;
		}
		for (let index = 0; index < entries.length && count < SEARCH_MATCH_LIMIT; index++) {
			const text = entryText(entries[index]);
			if (text?.toLowerCase().includes(lowered)) {
				matches.push(`${basename(ref.file)} [${index}] ${clip(text, SEARCH_SNIPPET_CHARS)}`);
				count++;
			}
		}
	}
	const text =
		matches.length > 0
			? matches.join("\n")
			: `No matches for "${clip(query, SEARCH_SNIPPET_CHARS)}" in ${files.length - skipped} transcript(s).`;
	return {
		text: skipped > 0 ? `${text}\n(${skipped} unreadable skipped)` : text,
		details: { action: "search", count, skipped: skipped > 0 ? skipped : undefined },
	};
}

function readSpan(
	dir: string,
	currentFile: string | undefined,
	sessionRef: string | undefined,
	start: number,
	end: number | undefined,
	signal: AbortSignal | undefined,
): { text: string; details: SessionsToolDetails } {
	const file = resolveSession(
		sessionRef,
		dir,
		sessionFiles(dir).filter((ref) => ref.file !== currentFile),
	);
	if (!file) {
		return { text: "No other session transcripts found; nothing to read.", details: { action: "read" } };
	}
	if (signal?.aborted) throw new Error("aborted");
	let entries: SessionEntry[];
	try {
		entries = loadEntries(file);
	} catch {
		return {
			text: `Unreadable or missing transcript: ${file}. Use action "list" to see readable transcripts.`,
			details: { action: "read", file },
		};
	}
	const spanStart = Math.max(0, Math.floor(start));
	const plural = (n: number) => `${n} entry${n === 1 ? "" : "s"}`;
	if (spanStart >= entries.length) {
		return {
			text: `start ${spanStart} is past the end of ${basename(file)} (${plural(entries.length)}); use the sessions list to see counts.`,
			details: { action: "read", file },
		};
	}
	const spanEnd = Math.min(entries.length, Math.floor(end ?? spanStart + READ_DEFAULT_SPAN));
	if (spanEnd <= spanStart) {
		return {
			text: `No entries in [${spanStart}, ${spanEnd}) of ${basename(file)} (${plural(entries.length)}).`,
			details: { action: "read", file },
		};
	}
	const lines: string[] = [];
	let total = 0;
	let rendered = 0;
	for (let index = spanStart; index < spanEnd; index++) {
		const line = renderEntry(index, entries[index]);
		if (!line) continue;
		if (total + line.length > READ_TOTAL_CHARS) {
			lines.push(`... truncated at ${READ_TOTAL_CHARS} chars; narrow the span to read more`);
			break;
		}
		lines.push(line);
		total += line.length;
		rendered++;
	}
	const text =
		lines.length > 0
			? `${basename(file)} entries [${spanStart}, ${spanEnd}):\n${lines.join("\n")}`
			: `${basename(file)} entries [${spanStart}, ${spanEnd}) contain no renderable messages.`;
	return { text, details: { action: "read", file, count: rendered } };
}

export function createSessionsToolDefinition(): ToolDefinition<typeof sessionsSchema, SessionsToolDetails> {
	return {
		name: SESSIONS_TOOL_NAME,
		label: SESSIONS_TOOL_NAME,
		description:
			"# Past session transcripts\n\nSearch and read previous session transcripts for this project (newest first). Use it to consult a session this one is linked to (see the session reference), or to recall decisions, file paths, or errors from earlier sessions. Prefer `search` over `read`, and keep `read` spans narrow: outputs are capped on purpose.",
		promptSnippet: "Search and read past session transcripts for this project",
		parameters: sessionsSchema,
		defaultActive: false,
		async execute(_toolCallId, { action, query, session, start, end }, signal, _onUpdate, ctx) {
			const dir = ctx.sessionManager.getSessionDir();
			const currentFile = ctx.sessionManager.getSessionFile();
			if (action === "list") {
				const { text, details } = listSessions(dir, currentFile);
				return { content: [{ type: "text", text }], details };
			}
			if (action === "search") {
				if (!query || query.trim() === "") throw new Error("search requires a query");
				const { text, details } = searchSessions(dir, currentFile, query, session, signal);
				return { content: [{ type: "text", text }], details };
			}
			const { text, details } = readSpan(dir, currentFile, session, start ?? 0, end, signal);
			return { content: [{ type: "text", text }], details };
		},
	};
}
