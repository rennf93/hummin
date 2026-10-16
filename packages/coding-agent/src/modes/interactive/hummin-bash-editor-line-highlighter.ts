import { highlightCode } from "./theme/theme.ts";

/** Syntax-highlights bash-mode input lines; other input renders unstyled. */
export class BashEditorLineHighlighter {
	private cache = new Map<string, string>();

	highlight(text: string, isBashMode: boolean): string {
		if (!isBashMode || !text.trimStart().startsWith("!")) {
			return text;
		}
		const cached = this.cache.get(text);
		if (cached !== undefined) {
			return cached;
		}
		let highlighted: string;
		try {
			highlighted = highlightCode(text, "bash")[0] ?? text;
		} catch {
			highlighted = text;
		}
		if (this.cache.size >= 256) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
		this.cache.set(text, highlighted);
		return highlighted;
	}

	clear(): void {
		this.cache.clear();
	}
}
