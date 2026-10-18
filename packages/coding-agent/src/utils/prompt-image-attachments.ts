/**
 * Paste-time image markers.
 *
 * Pasting an image (Finder copy, clipboard bitmap, or clipboard text that is
 * nothing but image file paths) inserts a compact `[Image N]` marker into the
 * editor right away, where N counts every image pasted in the session. On
 * submit, each marker still present in the text attaches its image bytes, so
 * the model sees the image immediately and the transcript stays legible.
 * Deleting a marker drops the image; hand-typed paths stay plain text.
 */

import { readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "./mime.ts";

/** A clipboard line that is an image file path: the unescaped `path` plus the original `raw` line. */
export interface PastedImagePath {
	path: string;
	raw: string;
}

/**
 * Parse clipboard text that consists exclusively of image file paths (one per line).
 * Absolute paths with an image extension only; `\ ` escape sequences from terminal-style
 * path text are unescaped, bare spaces pass through. Returns the entries in order, or
 * null when the text is anything else - prose with a path in it must stay plain text.
 */
export function parsePastedImagePathText(text: string): PastedImagePath[] | null {
	const lines = text
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return null;
	const entries: PastedImagePath[] = [];
	for (const line of lines) {
		const path = parseImagePathLine(line);
		if (!path) return null;
		entries.push({ path, raw: line });
	}
	return entries;
}

/**
 * Parse a single editor line that is exactly one absolute image file path and return the
 * unescaped path, or null. Accepts the shapes drag-and-drop inserts: bare paths, paths with
 * bare spaces, backslash-escaped paths (Warp, shell transcripts), and quoted paths
 * (Terminal.app). Prose, relative paths, and non-image extensions stay plain text.
 */
export function parseImagePathLine(line: string): string | null {
	let candidate = line.trim();
	const quote = candidate.at(0);
	if ((quote === '"' || quote === "'") && candidate.length > 1 && candidate.at(-1) === quote) {
		candidate = candidate.slice(1, -1);
	}
	if (!/^\/(?:[^\\]|\\.)+$/.test(candidate)) return null;
	if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(candidate)) return null;
	return candidate.replace(/\\(.)/g, "$1");
}

/** Return why `filePath` cannot attach as a pasted image, or null when it can. */
export async function imagePasteBlocker(filePath: string): Promise<string | null> {
	try {
		const stats = await stat(filePath);
		if (!stats.isFile()) return "not a regular file";
		const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
		if (!mimeType) return "not a supported image";
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Load the pending images for the `[Image N]` markers still present in the prompt
 * text, in marker order. Markers the user deleted - or numbers that were never
 * pasted - attach nothing.
 */
export async function collectPastedMarkerImages(
	text: string,
	pending: ReadonlyMap<number, string>,
): Promise<{ images: ImageContent[]; warnings: string[] }> {
	const images: ImageContent[] = [];
	const warnings: string[] = [];
	const seen = new Set<number>();
	for (const match of text.matchAll(/\[Image (\d+)\]/g)) {
		const index = Number(match[1]);
		const filePath = pending.get(index);
		if (filePath === undefined || seen.has(index)) continue;
		seen.add(index);
		const attachment = await loadImageAttachment(filePath, warnings);
		if (attachment) images.push(attachment);
	}
	return { images, warnings };
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
