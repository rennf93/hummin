import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { Context } from "../context.ts";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "../utils/truncate.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "./image.ts";
import { resolveReadToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

// An explicit tiny limit (e.g. limit:1) costs one LLM turn per line, and models
// imitate the continuation hint verbatim, so a file crawl at one line per turn
// is otherwise unbounded. Floor tiny limits and suggest a page size in the hint.
const MIN_EXPLICIT_LIMIT_LINES = 20;
const SUGGESTED_PAGE_LINES = 200;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(
		Type.Number({
			description: `Maximum number of lines to read (values below ${MIN_EXPLICIT_LIMIT_LINES} are raised to ${MIN_EXPLICIT_LIMIT_LINES})`,
		}),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export type ReadImageProcessorResult =
	| { ok: true; data: string; mimeType: string; hints: string[] }
	| { ok: false; message: string };

export type ReadImageProcessor = (
	bytes: Uint8Array,
	mimeType: string,
	options: { autoResizeImages: boolean },
	context: Context,
) => Promise<ReadImageProcessorResult>;

export interface ReadToolOptions {
	/** Whether an injected image processor should resize images. Default: true. */
	autoResizeImages?: boolean;
	/** Optional image conversion/resizing implementation. */
	imageProcessor?: ReadImageProcessor;
}

export function createReadTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: ReadToolOptions,
): AgentHarnessTool<TContext, typeof readSchema, ReadToolDetails | undefined> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, _onUpdate, { env }, _invocation, context) {
			const absolutePath = await resolveReadToolPath(env, path, context);
			const bytes = getOrThrow(await env.readBinaryFile(absolutePath, context));
			const mimeType = detectSupportedImageMimeType(bytes);
			if (mimeType) {
				if (options?.imageProcessor) {
					const processed = await options.imageProcessor(
						bytes,
						mimeType,
						{ autoResizeImages: options.autoResizeImages ?? true },
						context,
					);
					if (!processed.ok) {
						return {
							content: [{ type: "text", text: `Read image file [${mimeType}]\n${processed.message}` }],
							details: undefined,
						};
					}
					const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
					return {
						content: [
							{ type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
							{ type: "image", data: processed.data, mimeType: processed.mimeType },
						] satisfies Array<TextContent | ImageContent>,
						details: undefined,
					};
				}
				if (mimeType === "image/bmp") {
					return {
						content: [
							{
								type: "text",
								text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
							},
						],
						details: undefined,
					};
				}
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: encodeBase64(bytes), mimeType },
					] satisfies Array<TextContent | ImageContent>,
					details: undefined,
				};
			}

			const textContent = new TextDecoder().decode(bytes);
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				const effectiveLimit = Math.max(limit, MIN_EXPLICIT_LIMIT_LINES);
				const endLine = Math.min(startLine + effectiveLimit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(new TextEncoder().encode(allLines[startLine]).byteLength);
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				// Models copy the hint's pattern, so suggest a page size the
				// model can reuse when its chosen limit pages too thinly.
				const pageSize = Math.min(SUGGESTED_PAGE_LINES, remaining);
				const limitSuggestion = limit !== undefined && limit < SUGGESTED_PAGE_LINES ? ` (limit=${pageSize})` : "";
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset}${limitSuggestion} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
