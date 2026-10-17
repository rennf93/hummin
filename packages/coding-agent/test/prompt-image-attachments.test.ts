import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractImageAttachments, findPastedPathOccurrences } from "../src/utils/prompt-image-attachments.ts";

// Minimal 1x1 PNG (transparent pixel).
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-prompt-image-test-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writeImage(name: string): string {
	const filePath = join(directory, name);
	writeFileSync(filePath, TINY_PNG);
	return filePath;
}

function writeText(name: string, content: string): string {
	const filePath = join(directory, name);
	writeFileSync(filePath, content, "utf8");
	return filePath;
}

describe("findPastedPathOccurrences", () => {
	it("finds occurrences left to right across multiple known paths", () => {
		const a = "/tmp/a.png";
		const b = "/tmp/b.png";
		const text = `look at ${b} then ${a} again ${a}`;
		expect(findPastedPathOccurrences(text, [a, b])).toEqual([
			{ path: b, start: 8, end: 18 },
			{ path: a, start: 24, end: 34 },
			{ path: a, start: 41, end: 51 },
		]);
	});

	it("prefers the longer path at the same start", () => {
		const short = "/tmp/a.png";
		const long = "/tmp/a.png.bak";
		const occurrences = findPastedPathOccurrences(long, [short, long]);
		// Both matches are reported; extractImageAttachments skips the one swallowed by the longer path.
		expect(occurrences).toEqual([
			{ path: long, start: 0, end: long.length },
			{ path: short, start: 0, end: short.length },
		]);
	});

	it("ignores empty known paths", () => {
		expect(findPastedPathOccurrences("text", [""])).toEqual([]);
	});
});

describe("extractImageAttachments", () => {
	it("returns the text untouched when nothing is tracked", async () => {
		const imagePath = writeImage("logo.png");
		const text = `see ${imagePath}`;
		const result = await extractImageAttachments(text, new Set());
		expect(result).toEqual({ text, images: [], warnings: [] });
	});

	it("replaces a tracked image path with an [Image 1] marker and attaches the image", async () => {
		const imagePath = writeImage("logo.png");
		const result = await extractImageAttachments(`what is in ${imagePath} ?`, new Set([imagePath]));
		expect(result.text).toBe("what is in [Image 1] ?");
		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.type).toBe("image");
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.warnings).toEqual([]);
	});

	it("leaves untracked paths alone while converting tracked ones", async () => {
		const tracked = writeImage("tracked.png");
		const untracked = writeImage("untracked.png");
		const result = await extractImageAttachments(`${untracked} and ${tracked}`, new Set([tracked]));
		expect(result.text).toBe(`${untracked} and [Image 1]`);
		expect(result.images).toHaveLength(1);
	});

	it("numbers markers in reading order for repeated pastes", async () => {
		const first = writeImage("first.png");
		const second = writeImage("second.png");
		const result = await extractImageAttachments(`${first}\n${second}\n${first}`, new Set([first, second]));
		expect(result.text).toBe("[Image 1]\n[Image 2]\n[Image 3]");
		expect(result.images).toHaveLength(3);
	});

	it("does not double-consume overlapping paths", async () => {
		const short = writeImage("a.png");
		const long = `${short}.bak`;
		writeFileSync(long, TINY_PNG);
		const result = await extractImageAttachments(long, new Set([short, long]));
		expect(result.text).toBe("[Image 1]");
		expect(result.images).toHaveLength(1);
	});

	it("warns and keeps the text for a missing file", async () => {
		const missing = join(directory, "missing.png");
		const text = `show ${missing} please`;
		const result = await extractImageAttachments(text, new Set([missing]));
		expect(result.text).toBe(text);
		expect(result.images).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("missing.png");
	});

	it("warns and keeps the text for a non-image file", async () => {
		const textFile = writeText("notes.txt", "just text");
		const text = `show ${textFile}`;
		const result = await extractImageAttachments(text, new Set([textFile]));
		expect(result.text).toBe(text);
		expect(result.images).toEqual([]);
		expect(result.warnings[0]).toContain("not a supported image");
	});
});
