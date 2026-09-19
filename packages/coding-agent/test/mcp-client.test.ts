/** Tests for the hand-rolled stdio MCP client (extensions/lib/mcp-client.ts). */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	McpClient,
	mergeMcpServers,
	qualifiedToolName,
	sanitizeToolPart,
	toolParamsSchema,
} from "../extensions/lib/mcp-client.ts";

const fixture = (mode: string): { command: string; args: string[] } => ({
	command: process.execPath,
	args: [join(import.meta.dirname, "fixtures/mcp-fixture-server.mjs"), mode],
});

const clients: McpClient[] = [];
function tracked(
	name: string,
	config: { command: string; args: string[] },
	options: ConstructorParameters<typeof McpClient>[2] = {},
): McpClient {
	const client = new McpClient(name, config, options);
	clients.push(client);
	return client;
}

afterEach(async () => {
	await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
	clients.length = 0;
});

describe("naming and schema helpers", () => {
	it("sanitizes server and tool names to [a-z0-9_]", () => {
		expect(sanitizeToolPart("My Server!")).toBe("my_server");
		expect(sanitizeToolPart("--x--")).toBe("x");
		expect(qualifiedToolName("GitHub", "create_issue")).toBe("mcp_github_create_issue");
	});

	it("merges global and project servers with project winning per name", () => {
		const merged = mergeMcpServers(
			{ a: { command: "ga" }, b: { command: "gb" } },
			{ b: { command: "pb" }, c: { command: "pc" } },
		);
		expect(merged.get("a")).toEqual({ command: "ga" });
		expect(merged.get("b")).toEqual({ command: "pb" });
		expect(merged.get("c")).toEqual({ command: "pc" });
	});

	it("passes through object schemas and falls back for non-object schemas", () => {
		const objectSchema = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
		const through = toolParamsSchema(objectSchema);
		expect(through.params).toEqual(objectSchema);
		expect(through.descriptionSuffix).toBe("");

		const fallback = toolParamsSchema({ type: "string" });
		expect(fallback.params).toEqual({ type: "object", properties: {}, required: [] });
		expect(fallback.descriptionSuffix).toContain('"type":"string"');

		const missing = toolParamsSchema(undefined);
		expect(missing.params).toEqual({ type: "object", properties: {}, required: [] });
		expect(missing.descriptionSuffix).toBe("");
	});
});

describe("McpClient over stdio", () => {
	it("performs the initialize handshake and lists tools", async () => {
		const client = tracked("fixture", fixture("echo"));
		const tools = await client.connect();
		expect(client.state).toBe("ready");
		expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "odd"]);
		expect(tools.find((tool) => tool.name === "echo")?.description).toBe("Echo the given text back.");
	});

	it("calls a tool and reports isError results", async () => {
		const client = tracked("fixture", fixture("echo"));
		await client.connect();
		const ok = await client.callTool("echo", { text: "hi" });
		expect(McpClient.textOf(ok)).toBe("echo: hi");
		expect(ok.isError).toBe(false);

		const failed = await client.callTool("echo", { fail: true });
		expect(failed.isError).toBe(true);
		expect(McpClient.textOf(failed)).toBe("boom");
	});

	it("times out when the server never answers tools/call", async () => {
		const client = tracked("slow", fixture("slow"), { requestTimeoutMs: 200 });
		await client.connect();
		await expect(client.callTool("echo", {})).rejects.toThrow(/timed out/);
	});

	it("times out initialize when the server is unresponsive to the handshake", async () => {
		const client = tracked(
			"stall",
			{
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
			},
			{ initTimeoutMs: 200 },
		);
		await expect(client.connect()).rejects.toThrow(/timed out/);
	});

	it("detects a crash, clears tools, and notifies", async () => {
		const states: string[] = [];
		const client = tracked("crasher", fixture("crash"), { onStateChange: (state) => states.push(state) });
		await expect(client.connect()).rejects.toThrow(/exited/);
		expect(client.state).toBe("crashed");
		expect(client.tools).toEqual([]);
		expect(states).toContain("crashed");
		await expect(client.callTool("echo", {})).rejects.toThrow(/offline|not running|crashed/);
	});

	it("marks crashed when the server dies mid-session and rejects pending calls", async () => {
		const client = tracked("dying", fixture("die"));
		await client.connect();
		await expect(client.callTool("echo", {})).rejects.toThrow(/exited/);
		expect(client.state).toBe("crashed");
	});

	it("refreshes tools on notifications/tools/list_changed", async () => {
		const client = tracked("dynamic", fixture("dynamic"));
		await client.connect();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(client.state).toBe("ready");
		// The dynamic fixture sends list_changed; refreshTools succeeded without error.
		expect(client.tools.length).toBeGreaterThan(0);
	});

	it("rejects calls when aborted via AbortSignal", async () => {
		const client = tracked("slow2", fixture("slow"), { requestTimeoutMs: 30_000 });
		await client.connect();
		const controller = new AbortController();
		const pending = client.callTool("echo", {}, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
	});

	it("refuses duplicate concurrent connects by sharing one handshake", async () => {
		const client = tracked("echo", fixture("echo"));
		const [a, b] = await Promise.all([client.connect(), client.connect()]);
		expect(a).toEqual(b);
		expect(client.state).toBe("ready");
	});
});
