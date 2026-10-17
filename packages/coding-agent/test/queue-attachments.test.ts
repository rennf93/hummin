import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { queuedMessageToEditorText } from "../src/modes/interactive/queue-attachments.ts";

function makeRegistrar() {
	const files: string[] = [];
	return {
		files,
		register: (path: string) => {
			files.push(path);
			return `[Image ${files.length}]`;
		},
	};
}

test("restores image bytes into private files and marks them in the editor text", () => {
	const registrar = makeRegistrar();
	const text = queuedMessageToEditorText(
		{
			role: "user",
			timestamp: 0,
			content: [
				{ type: "text", text: "inspect" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			],
		},
		registrar.register,
	);
	const [prompt, marker] = text.split("\n");
	const file = registrar.files[0]!;
	try {
		expect(prompt).toBe("inspect");
		expect(marker).toBe("[Image 1]");
		expect(readFileSync(file, "utf8")).toBe("image");
		expect(file).toMatch(/\.png$/);
		if (process.platform !== "win32") {
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
		}
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
});

test("restores every queued image after the text in marker order", () => {
	const registrar = makeRegistrar();
	const text = queuedMessageToEditorText(
		{
			role: "user",
			timestamp: 0,
			content: [
				{ type: "text", text: "compare" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
				{ type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" },
			],
		},
		registrar.register,
	);
	try {
		expect(text).toBe("compare\n[Image 1]\n[Image 2]");
		expect(registrar.files[0]).toMatch(/1\.png$/);
		expect(registrar.files[1]).toMatch(/2\.jpg$/);
	} finally {
		for (const file of registrar.files) rmSync(dirname(file), { recursive: true, force: true });
	}
});

test("keeps plain text unchanged and rejects unsupported image types", () => {
	const registrar = makeRegistrar();
	expect(queuedMessageToEditorText({ role: "user", timestamp: 0, content: "hello" }, registrar.register)).toBe(
		"hello",
	);
	expect(() =>
		queuedMessageToEditorText(
			{ role: "user", timestamp: 0, content: [{ type: "image", mimeType: "image/unknown", data: "" }] },
			registrar.register,
		),
	).toThrow("Cannot restore queued image type");
	expect(registrar.files).toHaveLength(0);
});
