import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardFilePaths: mocks.readClipboardFilePaths,
	readClipboardText: mocks.readClipboardText,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: mocks.readClipboardImage,
}));

// Minimal 1x1 PNG (transparent pixel) so paste-time validation accepts the file.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

beforeEach(() => vi.resetAllMocks());

type PasteContext = {
	editor: {
		getCursor?: () => { line: number; col: number };
		getText?: () => string;
		insertTextAtCursor: (text: string) => void;
	};
	isBashMode?: boolean;
	pendingPastedImages: Map<number, string>;
	nextPastedImageIndex: number;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	registerPastedImage: (filePath: string) => string;
	insertAtCursorWithSpacing: (text: string) => void;
	pasteImageFiles: (entries: { path: string; raw: string }[]) => Promise<void>;
};

function makeContext(overrides: Partial<PasteContext> = {}): PasteContext {
	// handleClipboardPaste delegates to private sibling methods; attach the real
	// implementations so the exercised path is the production one.
	const methods = InteractiveMode.prototype as unknown as Pick<
		PasteContext,
		"registerPastedImage" | "insertAtCursorWithSpacing" | "pasteImageFiles"
	>;
	const context: PasteContext = {
		editor: { insertTextAtCursor: vi.fn() },
		pendingPastedImages: new Map<number, string>(),
		nextPastedImageIndex: 1,
		showWarning: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		registerPastedImage: methods.registerPastedImage,
		insertAtCursorWithSpacing: methods.insertAtCursorWithSpacing,
		pasteImageFiles: methods.pasteImageFiles,
		...overrides,
	};
	return context;
}

async function callHandleClipboardPaste(context: PasteContext): Promise<void> {
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: PasteContext): Promise<void>;
	};
	await prototype.handleClipboardPaste.call(context);
}

function writeTempImage(name: string, directory = mkdtempSync(join(tmpdir(), "hummin-paste-marker-"))): string {
	const filePath = join(directory, name);
	writeFileSync(filePath, TINY_PNG);
	return filePath;
}

test("Finder file paths take precedence over their icon image", async () => {
	// Regression test for #9999.
	const filePaths = ["/tmp/screenshot.png", "/tmp/My Photos/photo.png"];
	mocks.readClipboardFilePaths.mockResolvedValue(filePaths);
	mocks.readClipboardImage.mockResolvedValue({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	});
	mocks.readClipboardText.mockResolvedValue(null);
	const context = makeContext();
	await callHandleClipboardPaste(context);
	// Neither file exists, so both keep their path text instead of becoming markers.
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(filePaths.join("\n"));
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("existing image files become [Image N] markers and register pending attachments", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hummin-paste-marker-"));
	try {
		const first = join(directory, "first.png");
		const second = join(directory, "second.png");
		writeFileSync(first, TINY_PNG);
		writeFileSync(second, TINY_PNG);
		mocks.readClipboardFilePaths.mockResolvedValue([first, second]);
		mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });
		mocks.readClipboardText.mockResolvedValue(null);
		const context = makeContext();
		await callHandleClipboardPaste(context);
		expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("[Image 1]\n[Image 2]");
		expect(context.pendingPastedImages.get(1)).toBe(first);
		expect(context.pendingPastedImages.get(2)).toBe(second);
		expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing files keep their path text next to markers for existing ones", async () => {
	const existing = writeTempImage("kept.png");
	const directory = join(existing, "..");
	const missing = join(directory, "does-not-exist.png");
	mocks.readClipboardFilePaths.mockResolvedValue([existing, missing]);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue(null);
	const context = makeContext();
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(`[Image 1]\n${missing}`);
	expect(context.showWarning).toHaveBeenCalledTimes(1);
	rmSync(directory, { recursive: true, force: true });
});

test("marker numbers continue across pastes in the session", async () => {
	const existing = writeTempImage("fourth.png");
	const directory = join(existing, "..");
	mocks.readClipboardFilePaths.mockResolvedValue([existing]);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue(null);
	const context = makeContext({ nextPastedImageIndex: 4 });
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("[Image 4]");
	expect(context.pendingPastedImages.get(4)).toBe(existing);
	rmSync(directory, { recursive: true, force: true });
});

test("clipboard file paths containing terminal control characters are rejected", async () => {
	const context = makeContext();
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo\x1b]0;unsafe\x07.png"]);

	await callHandleClipboardPaste(context);

	expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(context.showError).toHaveBeenCalledExactlyOnceWith(
		"Failed to paste from clipboard: Clipboard file path contains control characters",
	);
});

test("native file-path errors are shown without falling through to the icon image", async () => {
	mocks.readClipboardFilePaths.mockRejectedValue(new Error("Native clipboard file read failed"));
	const context = makeContext();

	await callHandleClipboardPaste(context);

	expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(context.showError).toHaveBeenCalledExactlyOnceWith(
		"Failed to paste from clipboard: Native clipboard file read failed",
	);
});

test("clipboard bitmap images attach as [Image N] markers through a temp file", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	});
	mocks.readClipboardText.mockResolvedValue(null);
	const context = makeContext();
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("[Image 1]");
	const registeredPath = context.pendingPastedImages.get(1);
	expect(registeredPath).toBeTruthy();
	expect(readFileSync(registeredPath!)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	rmSync(registeredPath!, { force: true });
});

test.each([
	["punctuation", "Review:", 7],
	["Unicode text", "確認", 2],
])("clipboard file paths are separated from preceding %s", async (_description, editorText, cursorCol) => {
	const existing = writeTempImage("photo.png");
	const directory = join(existing, "..");
	mocks.readClipboardFilePaths.mockResolvedValue([existing]);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue(null);
	const context = makeContext({
		editor: {
			getCursor: () => ({ line: 0, col: cursorCol }),
			getText: () => editorText,
			insertTextAtCursor: vi.fn(),
		},
	});
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(" [Image 1]");
	rmSync(directory, { recursive: true, force: true });
});

test("bash mode shell-quotes file paths and inserts them as arguments", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue([
		"/tmp/My Photos/photo.png",
		"/tmp/$(touch hacked).png",
		"/tmp/plain.png",
	]);
	const context = makeContext({
		editor: {
			getCursor: () => ({ line: 0, col: 3 }),
			getText: () => "catDEST",
			insertTextAtCursor: vi.fn(),
		},
		isBashMode: true,
	});
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(
		" '/tmp/My Photos/photo.png' '/tmp/$(touch hacked).png' /tmp/plain.png ",
	);
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("clipboard text that is only image paths becomes markers", async () => {
	const existing = writeTempImage("shot.png");
	const directory = join(existing, "..");
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue(existing);
	const context = makeContext();
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("[Image 1]");
	expect(context.pendingPastedImages.get(1)).toBe(existing);
	rmSync(directory, { recursive: true, force: true });
});

test("escaped clipboard image paths unescape before validation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hummin paste dir-"));
	const existing = writeTempImage("shot 1.png", directory);
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue(existing.replace(/ /g, "\\ "));
	const context = makeContext();
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("[Image 1]");
	expect(context.pendingPastedImages.get(1)).toBe(existing);
	rmSync(directory, { recursive: true, force: true });
});

test("clipboard text that is not only image paths inserts as text", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue("see /tmp/photo.png here");
	const context = makeContext();
	await callHandleClipboardPaste(context);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("see /tmp/photo.png here");
	expect(context.pendingPastedImages.size).toBe(0);
});
