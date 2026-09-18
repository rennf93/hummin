/** Tests for the hand-rolled stdio LSP client (extensions/lib/lsp-client.ts). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatDiagnostics,
	hoverText,
	LspClient,
	languageIdFor,
	toLspPosition,
	uriToPath,
} from "../extensions/lib/lsp-client.ts";

const fixture = (mode: string): { command: string; args: string[] } => ({
	command: process.execPath,
	args: [join(import.meta.dirname, "fixtures/lsp-fixture-server.mjs"), mode],
});

const clients: LspClient[] = [];
function tracked(mode: string, options: ConstructorParameters<typeof LspClient>[2] = {}): LspClient {
	const client = new LspClient("fixture", fixture(mode), options);
	clients.push(client);
	return client;
}

afterEach(async () => {
	await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
	clients.length = 0;
});

function makeProjectFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "hummin-lsp-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	const file = join(dir, "src", "main.ts");
	writeFileSync(file, "const alpha: string = 'a';\nexport { alpha };\n");
	return file;
}

describe("coordinate and format helpers", () => {
	it("converts 1-based tool coordinates to 0-based LSP positions", () => {
		expect(toLspPosition(10, 5)).toEqual({ line: 9, character: 4 });
		expect(toLspPosition(1, 1)).toEqual({ line: 0, character: 0 });
		expect(toLspPosition(0, 0)).toEqual({ line: 0, character: 0 }); // clamped
	});

	it("formats diagnostics as line:col severity message (1-based display)", () => {
		const lines = formatDiagnostics([
			{ uri: "file:///a.ts", line: 2, character: 4, severity: 1, message: "Cannot find name 'foo'." },
			{ uri: "file:///a.ts", line: 0, character: 0, severity: 4, message: "hint here" },
		]);
		expect(lines).toEqual(["3:5 error Cannot find name 'foo'.", "1:1 hint hint here"]);
	});

	it("extracts hover text from markup contents", () => {
		expect(hoverText({ contents: { kind: "markdown", value: "const alpha: string" } })).toBe("const alpha: string");
		expect(hoverText({ contents: [{ value: "a" }, "b"] })).toBe("a\nb");
		expect(hoverText(undefined)).toBe("");
		expect(hoverText({})).toBe("");
	});

	it("maps extensions to LSP language identifiers", () => {
		expect(languageIdFor("/a/b.ts")).toBe("typescript");
		expect(languageIdFor("/a/b.tsx")).toBe("typescriptreact");
		expect(languageIdFor("/a/b.jsx")).toBe("javascriptreact");
		expect(languageIdFor("/a/b.js")).toBe("javascript");
	});

	it("round-trips file paths through file URIs", () => {
		expect(uriToPath("file:///tmp/x.ts")).toBe("/tmp/x.ts");
	});
});

describe("LspClient over stdio", () => {
	it("performs the initialize handshake with capabilities", async () => {
		const client = tracked("");
		await client.connect();
		expect(client.state).toBe("ready");
		expect(client.serverCapabilities?.hoverProvider).toBe(true);
		expect(typeof client.pid).toBe("number");
	});

	it("receives publishDiagnostics after didOpen and pulls them per file", async () => {
		const file = makeProjectFile();
		const client = tracked("");
		await client.connect();
		const uri = client.syncOpen(file);
		await vi_waitFor(() => client.getDiagnostics(uri).size > 0);
		const diags = client.getDiagnostics(uri).get(uri) ?? [];
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			line: 2,
			character: 4,
			severity: 1,
			message: "Cannot find name 'foo'.",
			source: "ts",
		});
		// empty for a file never opened
		expect(client.getDiagnostics("file:///never-opened.ts").size).toBe(0);
	});

	it("round-trips definition, references and hover requests", async () => {
		const file = makeProjectFile();
		const client = tracked("");
		await client.connect();
		// definition (single location)
		const definitions = await client.definition(file, 1, 7);
		expect(definitions).toEqual([{ uri: uriOf(file), line: 9, character: 2 }]);
		// references (multiple locations)
		const references = await client.references(file, 1, 7, true);
		expect(references).toHaveLength(2);
		expect(references[1]?.uri).toBe("file:///other/project/src/other.ts");
		// hover
		const hover = await client.hover(file, 1, 7);
		expect(hover).toBe("const alpha: string");
	});

	it("tolerates server-initiated requests without stalling", async () => {
		const file = makeProjectFile();
		const client = tracked("");
		await client.connect();
		await new Promise((resolve) => setTimeout(resolve, 150)); // fixture sends workspace/configuration
		const definitions = await client.definition(file, 1, 7);
		expect(definitions).toHaveLength(1);
		expect(client.state).toBe("ready");
	});

	it("times out requests that never answer (10s default, override for tests)", async () => {
		const file = makeProjectFile();
		const client = tracked("slow", { requestTimeoutMs: 80 });
		await client.connect();
		await expect(client.hover(file, 1, 1)).rejects.toThrow(/timed out after 80ms/);
	});

	it("rejects an aborted request via AbortSignal", async () => {
		const file = makeProjectFile();
		const client = tracked("slow");
		await client.connect();
		const controller = new AbortController();
		const pending = client.hover(file, 1, 1, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
	});

	it("rejects connect and reports crashed when the server exits after initialize", async () => {
		const states: string[] = [];
		const client = tracked("crash", { onStateChange: (state) => states.push(state) });
		await expect(client.connect()).rejects.toThrow(/exited/);
		expect(client.state).toBe("crashed");
		expect(states).toContain("crashed");
	});

	it("rejects pending requests and transitions to crashed when the server dies mid-session", async () => {
		const file = makeProjectFile();
		const crashes: Array<string | undefined> = [];
		const client = tracked("die", {
			onStateChange: (state, error) => {
				if (state === "crashed") crashes.push(error);
			},
		});
		await client.connect();
		const pending = client.definition(file, 1, 1);
		await expect(pending).rejects.toThrow(/exited|offline/);
		expect(client.state).toBe("crashed");
		expect(crashes).toHaveLength(1);
		// subsequent requests fail fast with an offline error
		await expect(client.definition(file, 1, 1)).rejects.toThrow(/offline/);
	});

	it("close+reopen: a second syncOpen sends didClose then didOpen", async () => {
		const file = makeProjectFile();
		const client = tracked("");
		await client.connect();
		client.syncOpen(file);
		client.syncOpen(file); // close+reopen (v1 content-sync policy)
		await vi_waitFor(() => (client.getDiagnostics().get(uriOf(file))?.length ?? 0) > 0);
		expect(client.getDiagnostics().get(uriOf(file))).toHaveLength(2); // re-pushed after reopen
	});
});

function uriOf(path: string): string {
	return `file://${path.split("\\").join("/")}`;
}

async function vi_waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
