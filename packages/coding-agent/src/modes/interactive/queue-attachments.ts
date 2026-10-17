import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai/compat";
import { extensionForImageMimeType } from "../../utils/clipboard-image.ts";

/** Restore images as private temp files, registering each for its `[Image N]` marker in the editor text. */
export function queuedMessageToEditorText(message: UserMessage, registerImageFile: (path: string) => string): string {
	if (typeof message.content === "string") return message.content;
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
	const images = message.content.filter((part) => part.type === "image");
	if (images.length === 0) return text;
	const extensions = images.map((image) => {
		const extension = extensionForImageMimeType(image.mimeType);
		if (!extension) throw new Error(`Cannot restore queued image type: ${image.mimeType}`);
		return extension;
	});
	const directory = mkdtempSync(join(tmpdir(), "hummin-queue-"));
	const markers = images.map((image, index) => {
		const file = join(directory, `${index + 1}.${extensions[index]}`);
		writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
		return registerImageFile(file);
	});
	return [text, ...markers].filter(Boolean).join("\n");
}
