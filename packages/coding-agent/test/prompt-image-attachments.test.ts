import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectPastedMarkerImages,
	imagePasteBlocker,
	parseImagePathLine,
	parsePastedImagePathText,
} from "../src/utils/prompt-image-attachments.ts";

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

describe("parsePastedImagePathText", () => {
	it("parses a single absolute image path", () => {
		const filePath = "/tmp/logo.png";
		expect(parsePastedImagePathText(filePath)).toEqual([{ path: filePath, raw: filePath }]);
	});

	it("unescapes shell-escaped spaces while keeping the raw line", () => {
		const raw = "/tmp/My\\ Shots/Screenshot\\ 2026-10-17\\ at\\ 22.27.28.png";
		expect(parsePastedImagePathText(raw)).toEqual([
			{ path: "/tmp/My Shots/Screenshot 2026-10-17 at 22.27.28.png", raw },
		]);
	});

	it("accepts bare-space paths as pasted by file managers", () => {
		const filePath = "/tmp/My Shots/Screenshot 2026-10-17.png";
		expect(parsePastedImagePathText(filePath)).toEqual([{ path: filePath, raw: filePath }]);
	});

	it("parses one path per line", () => {
		expect(parsePastedImagePathText("/tmp/a.png\n/tmp/b.jpg")).toEqual([
			{ path: "/tmp/a.png", raw: "/tmp/a.png" },
			{ path: "/tmp/b.jpg", raw: "/tmp/b.jpg" },
		]);
	});

	it("returns null for prose, relative paths, non-images, and empty text", () => {
		expect(parsePastedImagePathText(`see /tmp/logo.png for details`)).toBeNull();
		expect(parsePastedImagePathText("src/logo.png")).toBeNull();
		expect(parsePastedImagePathText("/tmp/notes.txt")).toBeNull();
		expect(parsePastedImagePathText("   \n  ")).toBeNull();
	});
});

describe("parseImagePathLine", () => {
	it("accepts bare, spaced, escaped, and quoted drop-shaped paths", () => {
		expect(parseImagePathLine("/tmp/shot.png")).toBe("/tmp/shot.png");
		expect(parseImagePathLine("/tmp/My Shots/shot.png")).toBe("/tmp/My Shots/shot.png");
		expect(parseImagePathLine("/tmp/My\\ Shots/shot.png")).toBe("/tmp/My Shots/shot.png");
		expect(parseImagePathLine("'/tmp/My Shots/shot.png'")).toBe("/tmp/My Shots/shot.png");
		expect(parseImagePathLine('"/tmp/My Shots/shot.png"')).toBe("/tmp/My Shots/shot.png");
	});

	it("rejects prose, relative paths, non-images, and unpaired quotes", () => {
		expect(parseImagePathLine("see /tmp/shot.png now")).toBeNull();
		expect(parseImagePathLine("src/shot.png")).toBeNull();
		expect(parseImagePathLine("/tmp/notes.txt")).toBeNull();
		expect(parseImagePathLine("'/tmp/shot.png")).toBeNull();
		expect(parseImagePathLine("")).toBeNull();
	});
});

describe("imagePasteBlocker", () => {
	it("accepts a readable image file", async () => {
		expect(await imagePasteBlocker(writeImage("logo.png"))).toBeNull();
	});

	it("rejects a missing file with the filesystem error", async () => {
		const blocker = await imagePasteBlocker(join(directory, "missing.png"));
		expect(blocker).toContain("missing.png");
	});

	it("rejects a non-image file", async () => {
		expect(await imagePasteBlocker(writeText("notes.txt", "just text"))).toBe("not a supported image");
	});
});

describe("collectPastedMarkerImages", () => {
	it("attaches pending images in marker order regardless of paste order", async () => {
		const first = writeImage("first.png");
		const second = writeImage("second.png");
		const pending = new Map([
			[1, first],
			[2, second],
		]);
		const result = await collectPastedMarkerImages(`compare [Image 2] with [Image 1]`, pending);
		expect(result.images).toHaveLength(2);
		expect(result.images[0]?.data).toBe(Buffer.from(TINY_PNG).toString("base64"));
		expect(result.warnings).toEqual([]);
	});

	it("attaches nothing for markers the user deleted", async () => {
		const imagePath = writeImage("logo.png");
		const result = await collectPastedMarkerImages("no markers left", new Map([[1, imagePath]]));
		expect(result.images).toEqual([]);
	});

	it("attaches a repeated marker once", async () => {
		const imagePath = writeImage("logo.png");
		const result = await collectPastedMarkerImages("[Image 1] and again [Image 1]", new Map([[1, imagePath]]));
		expect(result.images).toHaveLength(1);
	});

	it("ignores numbers that were never pasted", async () => {
		const imagePath = writeImage("logo.png");
		const result = await collectPastedMarkerImages("[Image 9]", new Map([[1, imagePath]]));
		expect(result.images).toEqual([]);
	});

	it("warns when a pending file disappeared before submit", async () => {
		const missing = join(directory, "missing.png");
		const result = await collectPastedMarkerImages("[Image 1]", new Map([[1, missing]]));
		expect(result.images).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("missing.png");
	});
});
