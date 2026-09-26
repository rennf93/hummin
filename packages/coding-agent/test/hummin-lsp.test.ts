/**
 * Tests for the hummin-lsp extension: the tool_result diagnostics push
 * channel (fake ExtensionAPI + fake client, following the fake pattern in
 * hummin-guardrails.test.ts) and the LspClient.waitForDiagnostics primitive
 * it builds on (real stdio fixture server).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDiagnosticsPushHandler,
	DIAGNOSTICS_PUSH_MAX_LINES,
	DIAGNOSTICS_PUSH_WAIT_MS,
	default as humminLsp,
} from "../extensions/hummin-lsp.ts";
import { LspClient, type LspDiagnostic, type LspServerState } from "../extensions/lib/lsp-client.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ToolResultEvent, ToolResultEventResult } from "../src/core/extensions/types.ts";

// ---------------------------------------------------------------------------
// Factory wiring: the push handler is registered even when the server is
// disabled or absent, so it must be inert without an entry.
// ---------------------------------------------------------------------------

function fakePi(): {
	api: ExtensionAPI;
	handlers: Map<string, Array<(event: unknown) => unknown>>;
	commands: string[];
} {
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	const commands: string[] = [];
	const api = {
		on: (event: string, handler: (event: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers, commands };
}

describe("humminLsp wiring", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "hummin-lsp-wiring-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("registers the diagnostics push channel and /lsp even when disabled", async () => {
		vi.stubEnv("HUMMIN_LSP", "0");
		const { api, handlers, commands } = fakePi();
		humminLsp(api);
		expect(handlers.get("tool_result")).toHaveLength(1);
		expect(commands).toContain("lsp");
		// Inert without a server: any tool result passes through unmodified.
		const handler = handlers.get("tool_result")![0]!;
		const event = {
			type: "tool_result",
			toolCallId: "t1",
			toolName: "edit",
			input: { path: "src/a.ts" },
			content: [{ type: "text", text: "ok" }],
			isError: false,
		} as unknown as ToolResultEvent;
		await expect(handler(event)).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Push channel behavior with a fake client.
// ---------------------------------------------------------------------------

function fakePushClient(
	options: { state?: LspServerState; diagnostics?: LspDiagnostic[] | undefined; failOpen?: boolean } = {},
) {
	const openedPaths: string[] = [];
	const client = {
		state: options.state ?? ("ready" as LspServerState),
		syncOpen: (filePath: string) => {
			if (options.failOpen) throw new Error("read failed");
			openedPaths.push(filePath);
			return `file://${filePath}`;
		},
		waitForDiagnostics: vi.fn(async () => options.diagnostics),
	};
	return { client: client as unknown as LspClient, openedPaths };
}

function pushEvent(overrides: Partial<{ toolName: string; path: string; isError: boolean }> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "t1",
		toolName: overrides.toolName ?? "edit",
		input: { path: overrides.path ?? "src/a.ts" },
		content: [{ type: "text", text: "edit ok" }],
		details: undefined,
		isError: overrides.isError ?? false,
	} as unknown as ToolResultEvent;
}

function lastText(result: ToolResultEventResult | undefined): string | undefined {
	const blocks = result?.content ?? [];
	const last = blocks[blocks.length - 1];
	return last?.type === "text" ? last.text : undefined;
}

const diag = (line: number, severity: number, message: string): LspDiagnostic => ({
	uri: "file:///proj/src/a.ts",
	line,
	character: 0,
	severity,
	message,
});

describe("createDiagnosticsPushHandler", () => {
	const cwd = "/proj";

	function handler(client: LspClient | undefined, waitMs?: number) {
		return createDiagnosticsPushHandler({ getClient: () => client, cwd, waitMs });
	}

	it("appends ordered, capped diagnostics to a successful TS edit", async () => {
		const { client, openedPaths } = fakePushClient({
			diagnostics: [
				diag(5, 3, "info note"),
				diag(2, 2, "second warning"),
				diag(0, 1, `error ${"x".repeat(10)}`),
				diag(1, 1, "second error"),
				diag(3, 2, "first warning"),
				...Array.from({ length: DIAGNOSTICS_PUSH_MAX_LINES }, (_, i) => diag(10 + i, 4, `hint ${i}`)),
			],
		});
		const total = 5 + DIAGNOSTICS_PUSH_MAX_LINES;
		const result = await handler(client)(pushEvent());
		// opened from the resolved project path, post-edit content
		expect(openedPaths).toEqual([join(cwd, "src/a.ts")]);
		expect(result?.isError).toBeUndefined();
		expect(result?.content).toHaveLength(2);
		expect(result?.content?.[0]).toEqual({ type: "text", text: "edit ok" });
		const text = lastText(result);
		const lines = text?.split("\n") ?? [];
		expect(lines[0]).toBe("LSP diagnostics for src/a.ts:");
		// errors before warnings before the rest; same severity keeps input order
		expect(lines[1]).toBe("1:1 error error xxxxxxxxxx");
		expect(lines[2]).toBe("2:1 error second error");
		expect(lines[3]).toBe("3:1 warning second warning");
		expect(lines[4]).toBe("4:1 warning first warning");
		expect(lines).toHaveLength(1 + DIAGNOSTICS_PUSH_MAX_LINES + 1);
		expect(lines[lines.length - 1]).toBe(`+${total - DIAGNOSTICS_PUSH_MAX_LINES} more (lsp_diagnostics for all)`);
	});

	it("reports a clean file as none", async () => {
		const { client } = fakePushClient({ diagnostics: [] });
		const result = await handler(client)(pushEvent());
		expect(lastText(result)).toBe("LSP diagnostics for src/a.ts: none");
	});

	it("distinguishes an absent diagnostics entry from a clean file", async () => {
		const { client } = fakePushClient({ diagnostics: undefined });
		const result = await handler(client)(pushEvent());
		expect(lastText(result)).toBe("LSP diagnostics for src/a.ts: unavailable (server did not report)");
	});

	it("ignores non-TS/JS paths without opening the file", async () => {
		const { client, openedPaths } = fakePushClient({ diagnostics: [] });
		for (const path of ["README.md", "package.json", "src/styles.css", "data.tsv"]) {
			await expect(handler(client)(pushEvent({ path }))).resolves.toBeUndefined();
		}
		expect(openedPaths).toEqual([]);
	});

	it("ignores error results and non-edit/write tools", async () => {
		const { client, openedPaths } = fakePushClient({ diagnostics: [] });
		await expect(handler(client)(pushEvent({ isError: true }))).resolves.toBeUndefined();
		await expect(handler(client)(pushEvent({ toolName: "bash", path: "src/a.ts" }))).resolves.toBeUndefined();
		expect(openedPaths).toEqual([]);
	});

	it("handles the write tool and absolute paths", async () => {
		const { client, openedPaths } = fakePushClient({ diagnostics: [diag(0, 1, "boom")] });
		const result = await handler(client)(pushEvent({ toolName: "write", path: "/other/main.tsx" }));
		expect(openedPaths).toEqual(["/other/main.tsx"]);
		expect(lastText(result)).toBe("LSP diagnostics for /other/main.tsx:\n1:1 error boom");
	});

	it("ignores requests while the server is not ready", async () => {
		const { client, openedPaths } = fakePushClient({ state: "crashed", diagnostics: [] });
		await expect(handler(client)(pushEvent())).resolves.toBeUndefined();
		expect(openedPaths).toEqual([]);
	});

	it("ignores requests without a server", async () => {
		await expect(handler(undefined)(pushEvent())).resolves.toBeUndefined();
	});

	it("returns the unmodified result when syncOpen throws", async () => {
		const { client } = fakePushClient({ diagnostics: [], failOpen: true });
		await expect(handler(client)(pushEvent())).resolves.toBeUndefined();
	});

	it("waits on the didOpen URI with the default budget", async () => {
		const { client } = fakePushClient({ diagnostics: [] });
		await handler(client)(pushEvent());
		const wait = (client as unknown as { waitForDiagnostics: ReturnType<typeof vi.fn> }).waitForDiagnostics;
		expect(wait).toHaveBeenCalledWith("file:///proj/src/a.ts", DIAGNOSTICS_PUSH_WAIT_MS);
	});
});

// ---------------------------------------------------------------------------
// LspClient.waitForDiagnostics against the stdio fixture server.
// ---------------------------------------------------------------------------

const fixture = (mode: string): { command: string; args: string[] } => ({
	command: process.execPath,
	args: [join(import.meta.dirname, "fixtures/lsp-fixture-server.mjs"), mode],
});

const clients: LspClient[] = [];
function tracked(mode: string): LspClient {
	const client = new LspClient("fixture", fixture(mode));
	clients.push(client);
	return client;
}

function makeProjectFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "hummin-lsp-push-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	const file = join(dir, "src", "main.ts");
	writeFileSync(file, "const alpha: string = 'a';\nexport { alpha };\n");
	return file;
}

function uriOf(path: string): string {
	return `file://${path.split("\\").join("/")}`;
}

describe("LspClient.waitForDiagnostics", () => {
	afterEach(async () => {
		await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
		clients.length = 0;
	});

	it("resolves with the published diagnostics after didOpen", async () => {
		const file = makeProjectFile();
		const client = tracked("");
		await client.connect();
		const pending = client.waitForDiagnostics(uriOf(file), 2000);
		client.syncOpen(file);
		await expect(pending).resolves.toHaveLength(2);
	});

	it("resolves undefined on timeout and drains pending waits on stop", async () => {
		const client = tracked("");
		await client.connect();
		await expect(client.waitForDiagnostics("file:///never-opened.ts", 30)).resolves.toBeUndefined();
		const pending = client.waitForDiagnostics("file:///never-opened.ts", 5000);
		await client.stop();
		await expect(pending).resolves.toBeUndefined();
	});
});
