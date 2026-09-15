import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

type MarkdownSession = Pick<SessionManager, "getCwd" | "getHeader" | "getBranch">;

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (!part || typeof part !== "object") return "";
			const item = part as {
				type?: unknown;
				text?: unknown;
				thinking?: unknown;
				name?: unknown;
				arguments?: unknown;
				mimeType?: unknown;
			};
			if (item.type === "text") return typeof item.text === "string" ? item.text : "";
			if (item.type === "thinking")
				return typeof item.thinking === "string"
					? `<details><summary>Thinking</summary>\n\n${item.thinking}\n\n</details>`
					: "";
			if (item.type === "toolCall")
				return `**Tool call:** \`${String(item.name ?? "unknown")}\`\n\n~~~json\n${JSON.stringify(item.arguments ?? {}, null, 2)}\n~~~`;
			if (item.type === "image") return `[Image${item.mimeType ? `: ${String(item.mimeType)}` : ""}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function entryMarkdown(entry: SessionEntry): string | undefined {
	if (entry.type === "message") {
		if (entry.message.role === "bashExecution")
			return `## Bash\n\n~~~sh\n${entry.message.command}\n~~~\n\n${entry.message.output || "[no output]"}`;
		const role =
			entry.message.role === "toolResult"
				? "Tool result"
				: entry.message.role[0].toUpperCase() + entry.message.role.slice(1);
		const body = contentText((entry.message as { content?: unknown }).content);
		return `## ${role}\n\n${body || "[empty]"}`;
	}
	if (entry.type === "compaction") return `## Compaction summary\n\n${entry.summary}`;
	if (entry.type === "branch_summary") return `## Branch summary\n\n${entry.summary}`;
	if (entry.type === "custom_message") {
		const body = typeof entry.content === "string" ? entry.content : contentText(entry.content);
		return `## ${entry.customType}\n\n${body}`;
	}
	if (entry.type === "model_change") return `*Model: ${entry.provider}/${entry.modelId}*`;
	if (entry.type === "thinking_level_change") return `*Thinking level: ${entry.thinkingLevel}*`;
	return undefined;
}

function defaultPath(cwd: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return resolve(cwd, `hummin-session-${stamp}.md`);
}

/** Export the active session branch as a readable Markdown transcript. */
export function exportSessionToMarkdown(
	sessionManager: MarkdownSession,
	outputPath?: string,
	overwrite = false,
): string {
	const isDefaultPath = outputPath === undefined;
	let filePath = resolve(sessionManager.getCwd(), outputPath ?? defaultPath(sessionManager.getCwd()));
	if (isDefaultPath) {
		const base = filePath.slice(0, -3);
		let suffix = 1;
		while (existsSync(filePath)) filePath = `${base}-${suffix++}.md`;
	} else if (existsSync(filePath) && !overwrite) {
		throw new Error(`File already exists: ${filePath}`);
	}
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const header = sessionManager.getHeader();
	if (!header) throw new Error("Cannot export an in-memory session to Markdown");
	const sections = sessionManager
		.getBranch()
		.map(entryMarkdown)
		.filter((section): section is string => section !== undefined);
	const markdown = `# Hummin session\n\n- Session: ${header.id}\n- Started: ${header.timestamp}\n- Working directory: ${header.cwd}\n\n${sections.join("\n\n")}\n`;
	writeFileSync(filePath, markdown, overwrite ? undefined : { flag: "wx" });
	return filePath;
}
