/**
 * Convert pasted image file paths in prompt text into image attachments.
 *
 * Clipboard paste inserts file paths as literal text (macOS screenshots land in
 * TemporaryItems with spaces in the name). At submit time those paths are
 * replaced with compact `[Image N]` markers and the image bytes are attached to
 * the message, so the model sees the image immediately instead of reading the
 * file itself - and the transcript stays legible.
 *
 * Only paths that were actually inserted by paste (tracked by the caller) are
 * converted. Hand-typed paths stay as text: rewriting a sentence that merely
 * mentions `src/logo.png` would silently change its meaning.
 */

import { readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "./mime.ts";

export interface ExtractedImagePrompt {
	/** Prompt text with converted paths replaced by `[Image N]` markers. */
	text: string;
	/** Attachments in marker order. */
	images: ImageContent[];
	/** Human-readable reasons why a tracked path was left as text. */
	warnings: string[];
}

interface PathOccurrence {
	path: string;
	start: number;
	end: number;
}

/** Find every occurrence of the known pasted paths in the text, left to right. */
export function findPastedPathOccurrences(text: string, knownPaths: Iterable<string>): PathOccurrence[] {
	const occurrences: PathOccurrence[] = [];
	for (const knownPath of knownPaths) {
		if (!knownPath) continue;
		let searchFrom = 0;
		while (true) {
			const start = text.indexOf(knownPath, searchFrom);
			if (start === -1) break;
			const end = start + knownPath.length;
			occurrences.push({ path: knownPath, start, end });
			searchFrom = end;
		}
	}
	// At equal start, the longer path wins (e.g. `a.png` vs `a.png.bak`).
	return occurrences.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Replace tracked pasted image paths with `[Image N]` markers and load the images. */
export async function extractImageAttachments(
	text: string,
	knownPaths: ReadonlySet<string>,
): Promise<ExtractedImagePrompt> {
	const images: ImageContent[] = [];
	const warnings: string[] = [];
	const occurrences = findPastedPathOccurrences(text, knownPaths);
	if (occurrences.length === 0) {
		return { text, images, warnings };
	}

	// Load every distinct path once; per-occurrence reuse keeps repeated pastes cheap.
	const loaded = new Map<string, ImageContent | null>();
	for (const occurrence of occurrences) {
		if (loaded.has(occurrence.path)) continue;
		loaded.set(occurrence.path, await loadImageAttachment(occurrence.path, warnings));
	}

	let result = "";
	let cursor = 0;
	let markerIndex = 0;
	for (const occurrence of occurrences) {
		if (occurrence.start < cursor) continue; // already consumed by a longer match
		const attachment = loaded.get(occurrence.path);
		if (!attachment) continue;
		markerIndex += 1;
		result += text.slice(cursor, occurrence.start);
		result += `[Image ${markerIndex}]`;
		cursor = occurrence.end;
		images.push(attachment);
	}
	result += text.slice(cursor);
	return { text: result, images, warnings };
}

async function loadImageAttachment(filePath: string, warnings: string[]): Promise<ImageContent | null> {
	try {
		const stats = await stat(filePath);
		if (!stats.isFile()) {
			warnings.push(`Skipped ${filePath}: not a regular file`);
			return null;
		}
		const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
		if (!mimeType) {
			warnings.push(`Skipped ${filePath}: not a supported image`);
			return null;
		}
		const content = await readFile(filePath);
		const processed = await processImage(content, mimeType, { autoResizeImages: true });
		if (!processed.ok) {
			warnings.push(`Skipped ${filePath}: ${processed.message}`);
			return null;
		}
		return { type: "image", mimeType: processed.mimeType, data: processed.data };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Skipped ${filePath}: ${message}`);
		return null;
	}
}
