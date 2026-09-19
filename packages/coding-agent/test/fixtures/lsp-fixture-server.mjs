/**
 * Fixture LSP server for lsp-client tests. LSP base protocol (Content-Length
 * framing) over stdio. Modes via argv:
 *   (none) — initialize + diagnostics push after didOpen + definition/
 *            references/hover answers + a workspace/configuration request
 *   slow   — hover requests never answer (timeout path)
 *   crash  — exits after initialize
 *   die    — exits mid-session while a definition request is pending
 */
const mode = process.argv[2] ?? "";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const lengthMatch = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd));
		if (!lengthMatch) return;
		const length = Number(lengthMatch[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length - bodyStart < length) return;
		const body = buffer.slice(bodyStart, bodyStart + length);
		buffer = buffer.slice(bodyStart + length);
		handle(JSON.parse(body));
	}
});

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(frame) {
	if (frame.method === "initialize") {
		if (mode === "crash") process.exit(0); // die before answering: connect must reject
		send({
			jsonrpc: "2.0",
			id: frame.id,
			result: { capabilities: { textDocumentSync: 1, hoverProvider: true }, serverInfo: { name: "fixture", version: "0.0.1" } },
		});
		return;
	}
	if (frame.method === "initialized") return;
	if (frame.method === "textDocument/didOpen") {
		// Push diagnostics for the opened file, as tsserver would.
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri: frame.params.textDocument.uri,
				diagnostics: [
					{ range: { start: { line: 2, character: 4 } }, severity: 1, message: "Cannot find name 'foo'.", source: "ts" },
					{ range: { start: { line: 4, character: 0 } }, severity: 2, message: "Unused identifier.", source: "ts" },
				],
			},
		});
		return;
	}
	if (frame.method === "textDocument/definition") {
		if (mode === "die") process.exit(1);
		send({
			jsonrpc: "2.0",
			id: frame.id,
			result: { uri: frame.params.textDocument.uri, range: { start: { line: 9, character: 2 } } },
		});
		return;
	}
	if (frame.method === "textDocument/references") {
		send({
			jsonrpc: "2.0",
			id: frame.id,
			result: [
				{ uri: frame.params.textDocument.uri, range: { start: { line: 0, character: 0 } } },
				{ uri: "file:///other/project/src/other.ts", range: { start: { line: 11, character: 7 } } },
			],
		});
		return;
	}
	if (frame.method === "textDocument/hover") {
		if (mode === "slow") return; // never answers: exercises the request timeout
		send({
			jsonrpc: "2.0",
			id: frame.id,
			result: { contents: "const alpha: string" },
		});
		return;
	}
	if (typeof frame.id === "number") {
		// Unknown request from the client: standard JSON-RPC error.
		send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "method not found" } });
	}
}

// Server-initiated request: the client must answer (MethodNotFound is fine)
// instead of stalling. Sent shortly after initialize.
if (mode !== "crash") {
	setTimeout(() => {
		send({ jsonrpc: "2.0", id: 9000, method: "workspace/configuration", params: { items: [{ section: "ts" }] } });
	}, 50);
}
