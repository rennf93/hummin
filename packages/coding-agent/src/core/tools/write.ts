import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync } from "fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { countLineChanges, generateUnifiedPatch } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { formatSize } from "./truncate.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

/** Display-oriented metadata stored with write tool results. */
export interface WriteToolDetails {
	/** Lines added relative to the previous file content (whole content for new files) */
	added: number;
	/** Lines removed relative to the previous file content */
	removed: number;
}

/** Max lines of the overwrite diff included in the tool result. */
const WRITE_DIFF_MAX_LINES = 60;

/** Human-readable line count with trailing-newline handling ("3 lines", "1 line"). */
function lineCountText(content: string): string {
	const lines = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

/**
 * Cap a unified diff for the tool result, keeping the head (where the change
 * starts) and marking the cut explicitly.
 */
export function truncateDiff(diff: string, maxLines = WRITE_DIFF_MAX_LINES): string {
	const trimmed = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
	const lines = trimmed.split("\n");
	if (lines.length <= maxLines) return trimmed;
	return `${lines.slice(0, maxLines).join("\n")}\n[diff truncated, ${lines.length - maxLines} more lines]`;
}

/**
 * Tool result text for a write. New files get line/byte counts only (the
 * model just authored the content); overwrites also get a bounded unified
 * diff so the model can self-verify what replaced the previous bytes. The
 * first line always starts with "Successfully wrote to <path>".
 */
export function writeResultText(path: string, previousContent: string | null, content: string): string {
	const firstLine = `Successfully wrote to ${path} (${lineCountText(content)}, ${formatSize(Buffer.byteLength(content, "utf8"))})`;
	if (previousContent === null || previousContent === content) return firstLine;
	return `${firstLine}\n\n${truncateDiff(generateUnifiedPatch(path, previousContent, content))}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
	customCwd = false,
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd && !customCwd ? ctx.cwd : cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Capture previous content for the diff stat before overwriting.
				const existed = existsSync(absolutePath);
				const previousContent = existed ? readFileSync(absolutePath, "utf8") : null;
				const stat = countLineChanges(previousContent ?? "", content);

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: writeResultText(path, previousContent, content) }],
					details: { added: stat.added, removed: stat.removed } satisfies WriteToolDetails,
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(
	cwd: string,
	options?: WriteToolOptions,
	customCwd = false,
): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options, customCwd));
}
