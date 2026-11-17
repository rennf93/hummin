import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "./session-manager.ts";

/** Kind of secret detected by maskSecrets(). */
export type SecretKind =
	| "github"
	| "openai"
	| "anthropic"
	| "openrouter"
	| "aws-access"
	| "aws-secret"
	| "bearer"
	| "private-key";

function redaction(kind: SecretKind): string {
	return `[REDACTED:${kind}]`;
}

interface SecretPattern {
	kind: SecretKind;
	regex: RegExp;
	/**
	 * Optional replacement that keeps a capture group, used to preserve the
	 * credential label for aws-secret. Defaults to replacing the whole match.
	 */
	replace?: (match: string, label: string) => string;
}

/**
 * High-precision token patterns only. Every pattern requires either a
 * provider-specific token shape or an explicit credential label, so normal
 * code such as `const x = "sk-" + suffix` is never masked.
 *
 * Order matters: PEM blocks and Authorization headers run first so tokens
 * inside them are consumed exactly once, and AWS access keys run before the
 * aws-secret label scan so they are never swallowed by it.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
	{
		kind: "private-key",
		regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{
		kind: "bearer",
		// Covers plain `Authorization: Bearer <token>` headers and the JSON
		// serialization `"Authorization": "Bearer <token>"`; the surrounding
		// quotes stay in the text because the match starts inside them.
		regex: /[Aa]uthorization["']?\s*:\s*["']?[Bb]earer\s+[A-Za-z0-9._~+/=-]+/g,
	},
	{
		kind: "github",
		regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
	},
	{
		kind: "openai",
		regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
	},
	{
		kind: "anthropic",
		regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
	},
	{
		kind: "openrouter",
		regex: /\bsk-or-v1-[a-f0-9]{32,}\b/g,
	},
	{
		kind: "openai",
		regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
	},
	{
		kind: "aws-access",
		regex: /\bAKIA[0-9A-Z]{16}\b/g,
	},
	{
		kind: "aws-secret",
		// 40-character base64-ish run on the same line as, and shortly after, an
		// aws ... secret/key label. The label is kept; only the key is redacted.
		// The short separator gap tolerates shapes like `key=`, `key: "`, or `key = "`.
		regex: /(aws.{0,20}(?:secret|key)[ \t"'=:,]{0,5})([A-Za-z0-9/+=]{40})/gi,
		replace: (_match, label) => `${label}${redaction("aws-secret")}`,
	},
];

/**
 * Replace known secret token formats with `[REDACTED:<kind>]` placeholders.
 * Only high-precision patterns are masked; passing normal code through
 * unchanged is a hard requirement.
 */
export function maskSecrets(text: string): string {
	let masked = text;
	for (const pattern of SECRET_PATTERNS) {
		masked = pattern.replace
			? masked.replace(pattern.regex, pattern.replace)
			: masked.replace(pattern.regex, redaction(pattern.kind));
	}
	return masked;
}

function maskTextParts<T extends { type: string; text?: string; data?: string }>(parts: readonly T[]): T[] {
	return parts.map((part) => {
		// "text" is the visible channel; "thinking" is the model's reasoning, which can
		// echo secrets it saw and is persisted just the same.
		if ((part.type !== "text" && part.type !== "thinking") || typeof part.text !== "string") return part;
		return { ...part, text: maskSecrets(part.text) };
	});
}

/** Recursively mask every string value inside structured tool-call arguments. */
function maskDeepStrings(value: unknown): unknown {
	if (typeof value === "string") return maskSecrets(value);
	if (Array.isArray(value)) return value.map(maskDeepStrings);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskDeepStrings(entry)]));
	}
	return value;
}

function maskStringContent(content: string): string {
	return maskSecrets(content);
}

/** Content of user and custom messages: a string or text/image parts. */
function maskUserContent(content: string | (TextContent | ImageContent)[]): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return maskStringContent(content);
	if (!Array.isArray(content)) return content; // Sessions load without validation.
	return maskTextParts(content);
}

function maskAssistantContent(
	content: (TextContent | ThinkingContent | ToolCall)[],
): (TextContent | ThinkingContent | ToolCall)[] {
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		// Tool-call arguments are user-shaped input (commands, file content, keys passed
		// as flags) and carry the same leak risk as tool results.
		if (part.type === "toolCall" && part.arguments !== undefined) {
			return { ...part, arguments: maskDeepStrings(part.arguments) as typeof part.arguments };
		}
		return maskTextParts([part])[0];
	});
}

function maskToolResultContent(content: ToolResultMessage["content"]): ToolResultMessage["content"] {
	if (!Array.isArray(content)) return content;
	return maskTextParts(content);
}

function maskAgentMessage(message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "assistant":
			return { ...message, content: maskAssistantContent(message.content) };
		case "toolResult":
			return { ...message, content: maskToolResultContent(message.content) };
		case "user":
		case "custom":
			return { ...message, content: maskUserContent(message.content) };
		case "system": {
			const content = message.content;
			if (typeof content === "string") return { ...message, content: maskStringContent(content) };
			if (!Array.isArray(content)) return message;
			return { ...message, content: content.map((part) => ({ ...part, text: maskSecrets(part.text) })) };
		}
		case "bashExecution":
			// Shell commands and their output are text strings inside the message
			// and a common way secrets land in a session transcript.
			return { ...message, command: maskSecrets(message.command), output: maskSecrets(message.output) };
		default:
			return message;
	}
}

/**
 * Return a copy of the entry with every text string inside `message` and
 * `custom_message` content run through maskSecrets(). Images and non-text
 * content are untouched, all other entry types pass through unchanged, and the
 * original entry object is never mutated.
 */
export function maskSessionEntry(entry: SessionEntry): SessionEntry {
	if (entry.type === "message") {
		const messageEntry = entry as SessionMessageEntry;
		return { ...messageEntry, message: maskAgentMessage(messageEntry.message) };
	}
	if (entry.type === "custom_message") {
		const customEntry = entry as CustomMessageEntry;
		return { ...customEntry, content: maskUserContent(customEntry.content) };
	}
	return entry;
}
