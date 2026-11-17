/**
 * Session reference: the pointer a `/carry` session keeps to the session it left behind.
 *
 * `/carry` starts an empty session like `/clear`, but records the previous session in the new
 * header (`parentSession`) and appends a small advisory pointer message so the model knows the
 * full transcript exists on disk and where. Nothing is carried over and nothing is summarized
 * eagerly: the new session decides what, if anything, is worth pulling in (via the `sessions`
 * tool or a direct read of the transcript).
 */

import type { SessionEntry } from "./session-manager.ts";

export const SESSION_REFERENCE_CUSTOM_TYPE = "session-reference";

/** Text caps, chosen so the whole pointer stays in the ~100-150 token range. */
const FIRST_USER_TEXT_CAP = 120;
const LAST_ASSISTANT_TEXT_CAP = 200;
const NOTE_CAP = 200;

export interface SessionReferenceInfo {
	/** Absolute path of the previous session transcript (jsonl). */
	sessionFile: string;
	/** Number of entries in the previous session. */
	entryCount: number;
	/** Text of the previous session's first user message, when one exists. */
	firstUserText?: string;
	/** Text of the previous session's last assistant message, when one exists. */
	lastAssistantText?: string;
	/** Optional focus note passed to `/carry <note>`. */
	note?: string;
}

/** Minimal structural view of an agent message, so extraction needs no SDK type imports. */
interface TextLikeMessage {
	role: string;
	content?: string | readonly { type: string; text?: string }[];
	toolName?: string;
}

/** Flat text of a message's text content parts (ignores images and thinking blocks). */
export function messageText(message: TextLikeMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function collapse(text: string, cap: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap - 1)}...` : flat;
}

function isMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
	return entry.type === "message";
}

/** Text of the session's first user message, for the "where it began" line. */
export function extractFirstUserText(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (isMessageEntry(entry) && entry.message.role === "user") {
			const text = messageText(entry.message).trim();
			if (text) return text;
		}
	}
	return undefined;
}

/** Text of the session's last assistant message, for the "where it ended" line. */
export function extractLastAssistantText(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isMessageEntry(entry) && entry.message.role === "assistant") {
			const text = messageText(entry.message).trim();
			if (text) return text;
		}
	}
	return undefined;
}

export function buildSessionReferenceContent(info: SessionReferenceInfo): string {
	const lines = [
		"[session reference] This session was started with /carry: it is linked to a previous session whose transcript is NOT in context.",
		`Previous transcript: ${info.sessionFile} (${info.entryCount} entries, left on disk untouched)`,
	];
	if (info.firstUserText) lines.push(`It began with: "${collapse(info.firstUserText, FIRST_USER_TEXT_CAP)}"`);
	if (info.lastAssistantText)
		lines.push(`It ended with: "${collapse(info.lastAssistantText, LAST_ASSISTANT_TEXT_CAP)}"`);
	if (info.note) lines.push(`Focus for this session: ${collapse(info.note, NOTE_CAP)}`);
	lines.push(
		"This is background reference only: consult it (sessions tool, or grep/read of the file) when the current task touches it, and do not assume its constraints carry over.",
	);
	return lines.join("\n");
}

/**
 * The pointer is persisted by the caller via `SessionManager.appendCustomMessageEntry` (the
 * canonical `custom_message` entry type, `display: false`), so it projects as a `custom` role
 * message while staying invisible in the TUI; the command prints the human-facing banner.
 */
