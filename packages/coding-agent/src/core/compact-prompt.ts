/**
 * Compact prompt mode: cuts fixed prompt overhead (tool descriptions + schema
 * descriptions + system-prompt guidance) for slow-prefill local models.
 *
 * The compaction is mechanical and lossy by design: the model keeps tool names,
 * parameter shapes, and required fields, but loses prose explanations. Opt-in
 * via the `compactPrompt` setting.
 */

import type { TSchema } from "typebox";

/** Hard cap for a compacted tool description. */
const MAX_COMPACT_DESCRIPTION_CHARS = 240;

/**
 * Condense a tool description to its first paragraph, capped at a sentence
 * boundary near the character cap.
 */
export function compactToolDescription(description: string): string {
	const firstParagraph = description.split(/\n\n+/)[0].trim();
	if (firstParagraph.length <= MAX_COMPACT_DESCRIPTION_CHARS) {
		return firstParagraph;
	}
	const window = firstParagraph.slice(0, MAX_COMPACT_DESCRIPTION_CHARS);
	const lastSentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
	if (lastSentenceEnd > 0) {
		return window.slice(0, lastSentenceEnd + 1);
	}
	return window.trimEnd();
}

/**
 * Return a deep copy of a JSON schema with every `description` key removed.
 * Types, enums, defaults, required arrays, and property structure are kept.
 */
export function stripSchemaDescriptions<T extends TSchema>(schema: T): T {
	return stripDescriptions(schema) as T;
}

function stripDescriptions(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripDescriptions);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === "description") {
				continue;
			}
			out[key] = stripDescriptions(item);
		}
		return out;
	}
	return value;
}
