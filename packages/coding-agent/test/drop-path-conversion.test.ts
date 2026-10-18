import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// Minimal 1x1 PNG (transparent pixel).
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-drop-convert-"));
	vi.restoreAllMocks();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

type ConvertContext = {
	pendingPastedImages: Map<number, string>;
	nextPastedImageIndex: number;
	isExtensionCommand: (text: string) => boolean;
	showWarning: (message: string) => void;
	/** Prototype method bound to the context by makeContext. */
	registerPastedImage: (filePath: string) => string;
};

async function convert(context: ConvertContext, text: string): Promise<{ text: string; images: unknown[] }> {
	const prototype = InteractiveMode.prototype as unknown as {
		convertPastedImages(this: ConvertContext, text: string): Promise<{ text: string; images: unknown[] }>;
	};
	return prototype.convertPastedImages.call(context, text);
}

function makeContext(overrides: Partial<ConvertContext> = {}): ConvertContext {
	const prototype = InteractiveMode.prototype as unknown as {
		registerPastedImage(this: ConvertContext, filePath: string): string;
	};
	return {
		pendingPastedImages: new Map<number, string>(),
		nextPastedImageIndex: 1,
		isExtensionCommand: () => false,
		showWarning: vi.fn(),
		registerPastedImage: prototype.registerPastedImage,
		...overrides,
	};
}

describe("convertPastedImages drag-and-drop line conversion", () => {
	it("converts a lone dropped path line into a marker and attaches the image", async () => {
		const filePath = join(directory, "dropped shot.png");
		writeFileSync(filePath, TINY_PNG);
		const context = makeContext();
		const result = await convert(context, filePath.replace(/ /g, "\\ "));
		expect(result.text).toBe("[Image 1]");
		expect(result.images).toHaveLength(1);
		expect(context.pendingPastedImages.get(1)).toBe(filePath);
	});

	it("converts only the path lines of a mixed message", async () => {
		const image = join(directory, "pic.png");
		writeFileSync(image, TINY_PNG);
		const context = makeContext();
		const result = await convert(context, `compare this with the old one\n${image}\nand explain`);
		expect(result.text).toBe("compare this with the old one\n[Image 1]\nand explain");
		expect(result.images).toHaveLength(1);
	});

	it("keeps relative and missing paths as text and warns for absolute image-shaped lines", async () => {
		const context = makeContext();
		const missing = join(directory, "gone.png");
		const result = await convert(context, `src/logo.png\n${missing}`);
		expect(result.text).toBe(`src/logo.png\n${missing}`);
		expect(result.images).toHaveLength(0);
		expect(context.showWarning).toHaveBeenCalledTimes(1);
	});

	it("numbering continues from earlier pastes in the session", async () => {
		const image = join(directory, "second.png");
		writeFileSync(image, TINY_PNG);
		const context = makeContext({ nextPastedImageIndex: 5 });
		const result = await convert(context, image);
		expect(result.text).toBe("[Image 5]");
		expect(context.pendingPastedImages.get(5)).toBe(image);
	});

	it("passes extension commands through untouched", async () => {
		const context = makeContext({ isExtensionCommand: () => true });
		const result = await convert(context, "/tmp/cmd.png");
		expect(result.text).toBe("/tmp/cmd.png");
		expect(result.images).toHaveLength(0);
	});
});
