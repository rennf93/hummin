import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../config.ts";

/**
 * Prompt history persists across sessions per project (cwd), stored under the agent directory so project dirs stay clean.
 * Newest entries first.
 */
export function getPromptHistoryFile(cwd: string): string {
	return path.join(
		getAgentDir(),
		"history",
		`${crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`,
	);
}

export function restorePromptHistory(editor: { setHistory(entries: string[]): void }, getFile: () => string): void {
	editor.setHistory([]);
	try {
		const file = getFile();
		if (!fs.existsSync(file)) return;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return;
		const entries = parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 500);
		editor.setHistory(entries);
	} catch {
		// Corrupt or unreadable history is not worth reporting.
	}
}

export function rememberPromptHistory(
	editor: { addToHistory?(text: string): void },
	getFile: () => string,
	text: string,
): void {
	const trimmed = text.trim();
	editor.addToHistory?.(text);
	if (!trimmed) return;
	try {
		const file = getFile();
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		let entries: string[] = [];
		if (fs.existsSync(file)) {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
				if (Array.isArray(parsed)) entries = parsed.filter((entry): entry is string => typeof entry === "string");
			} catch {
				// A corrupt history must not prevent subsequent prompts from being saved.
			}
		}
		if (entries[0] === trimmed) return;
		entries = [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, 500);
		fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
	} catch {
		// Best effort persistence.
	}
}
