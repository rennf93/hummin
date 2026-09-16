import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { queuedMessageToEditorText } from "../src/modes/interactive/queue-attachments.ts";

test("restores image bytes into private files alongside the queued text", () => {
	const text = queuedMessageToEditorText({
		role: "user",
		timestamp: 0,
		content: [
			{ type: "text", text: "inspect" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		],
	});
	const [prompt, file] = text.split("\n");
	try {
		expect(prompt).toBe("inspect");
		expect(readFileSync(file, "utf8")).toBe("image");
		expect(file).toMatch(/\.png$/);
		if (process.platform !== "win32") {
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
		}
	} finally {
		rmSync(dirname(file), { recursive: true });
	}
});
test("keeps plain text unchanged and rejects unsupported image types", () => {
	expect(queuedMessageToEditorText({ role: "user", timestamp: 0, content: "hello" })).toBe("hello");
	expect(() =>
		queuedMessageToEditorText({
			role: "user",
			timestamp: 0,
			content: [{ type: "image", mimeType: "image/unknown", data: "" }],
		}),
	).toThrow("Cannot restore queued image type");
});
