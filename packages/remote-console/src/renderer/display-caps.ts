/**
 * renderer/display-caps: DOM render caps for untrusted text. The extension already caps
 * wire blocks at 40000 characters; the renderer applies its own smaller caps so a hostile
 * or degenerate block can never materialize an unbounded DOM. Every cap renders with an
 * explicit truncation notice, never a silent cut.
 */

/** Cap for a whole text or code block (markdown source, code content). */
export const RENDER_CAP_CHARS = 20000;

/** Cap for snippets inside cards: args JSON, command text, results, diff sides. */
export const SNIPPET_CAP_CHARS = 4000;

export interface CappedText {
	shown: string;
	truncated: boolean;
	total: number;
}

/** Slices text to capChars for display, recording the original length. */
export function capForDisplay(text: string, capChars: number): CappedText {
	if (text.length <= capChars) return { shown: text, truncated: false, total: text.length };
	return { shown: text.slice(0, capChars), truncated: true, total: text.length };
}
