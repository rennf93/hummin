/**
 * Fixture MCP server for mcp-client tests. Newline-delimited JSON-RPC 2.0 over
 * stdio. Modes via argv:
 *   echo    — tools list + a working echo tool (default)
 *   slow    — tools/call never answers (timeout path)
 *   crash   — exits after initialize
 *   dynamic — pushes notifications/tools/list_changed after initialize
 */
const mode = process.argv[2] ?? "echo";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) handle(line);
	}
});

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
	const reply = (result) => send({ jsonrpc: "2.0", id: frame.id, result });
	if (frame.method === "initialize") {
		reply({
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "fixture", version: "0.0.1" },
		});
		return;
	}
	if (mode === "crash") {
		process.exit(0);
	}
	if (frame.method === "tools/list") {
		reply({
			tools: [
				{
					name: "echo",
					description: "Echo the given text back.",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				},
				{
					name: "odd",
					description: "Tool with a non-object schema (fallback path).",
					inputSchema: { type: "string" },
				},
			],
		});
		return;
	}
	if (frame.method === "tools/call") {
		if (mode === "slow") return; // never answers: exercises the call timeout
		if (mode === "die") process.exit(1); // crash mid-session with a call pending
		const args = frame.params?.arguments ?? {};
		if (args.fail) {
			reply({ content: [{ type: "text", text: "boom" }], isError: true });
			return;
		}
		reply({ content: [{ type: "text", text: `echo: ${args.text ?? ""}` }], isError: false });
		return;
	}
	// unknown method: JSON-RPC error
	send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "method not found" } });
}

if (mode === "dynamic") {
	setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 100);
}
