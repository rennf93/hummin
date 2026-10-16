import type { AgentSession } from "../../core/agent-session.ts";
import { exportSessionToMarkdown } from "../../core/export-markdown.ts";

/** /export with no path or a .md path writes Markdown; undefined means the user declined to overwrite. */
export async function exportMarkdownConfirmingOverwrite(
	session: Pick<AgentSession, "sessionManager" | "extensionRunner">,
	outputPath: string | undefined,
): Promise<string | undefined> {
	if (!outputPath) return exportSessionToMarkdown(session.sessionManager);
	try {
		return exportSessionToMarkdown(session.sessionManager, outputPath);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("File already exists:")) throw error;
		const confirmed = await session.extensionRunner
			.getUIContext()
			.confirm("Overwrite Markdown export?", error.message);
		if (!confirmed) return undefined;
		return exportSessionToMarkdown(session.sessionManager, outputPath, true);
	}
}
