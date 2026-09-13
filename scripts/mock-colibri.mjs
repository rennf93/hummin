#!/usr/bin/env node
// Mock colibri server for developing and testing the zcode-colibri extension
// without a NAS. Mimics the real colibri server surface:
//   GET  /health              -> { status, model, busy }
//   GET  /v1/models           -> OpenAI-style model list
//   POST /v1/chat/completions -> OpenAI-compatible reply, SSE when stream:true
//   POST /v1/messages         -> Anthropic-compatible reply, SSE
// One generation at a time: while busy, new requests get HTTP 429 with an
// x-colibri-queue-wait-ms header, like the real server's admission queue.
//
// Usage:
//   node scripts/mock-colibri.mjs [--port 9998] [--model glm-5.3-flash]
//        [--latency-ms 120] [--chunks 14]
// Multiple instances: run one process per port.

import http from "node:http";

function argValue(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const port = Number(argValue("--port", 9998));
const modelId = argValue("--model", "glm-5.3-flash");
const latencyMs = Number(argValue("--latency-ms", 120));
const chunks = Number(argValue("--chunks", 14));

let busy = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, body, headers = {}) {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => (data += chunk));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function sseWrite(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Streams a fixed lorem-style response so clients can assert on chunk flow.
async function streamOpenAI(res, parsed) {
	const created = Math.floor(Date.now() / 1000);
	const id = `chatcmpl-mock-${created}`;
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	sseWrite(res, {
		id,
		object: "chat.completion.chunk",
		created,
		model: modelId,
		choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
	});
	const text =
		parsed.messages?.filter((m) => m.role === "user").at(-1)?.content ??
		"Hello from the mock colibri server.";
	for (let i = 0; i < chunks; i++) {
		await sleep(latencyMs);
		sseWrite(res, {
			id,
			object: "chat.completion.chunk",
			created,
			model: modelId,
			choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null }],
		});
	}
	await sleep(latencyMs);
	sseWrite(res, {
		id,
		object: "chat.completion.chunk",
		created,
		model: modelId,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	});
	res.write("data: [DONE]\n\n");
	res.end();
	return `[mock] ${text}`;
}

async function openaiChat(req, res) {
	if (busy) {
		sendJson(res, 429, { error: { message: "server busy, one generation at a time", type: "busy" } }, {
			"x-colibri-queue-wait-ms": String(1500),
		});
		return;
	}
	busy = true;
	try {
		const parsed = JSON.parse((await readBody(req)) || "{}");
		if (parsed.stream) {
			await streamOpenAI(res, parsed);
		} else {
			await sleep(latencyMs * 3);
			const text = `Hello from the mock colibri server (${modelId}).`;
			sendJson(res, 200, {
				id: `chatcmpl-mock-${Date.now()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: modelId,
				choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
			});
		}
	} catch (error) {
		sendJson(res, 400, { error: { message: String(error) } });
	} finally {
		busy = false;
	}
}

async function anthropicMessages(req, res) {
	if (busy) {
		sendJson(res, 429, { type: "error", error: { type: "overloaded_error", message: "server busy" } }, {
			"x-colibri-queue-wait-ms": String(1500),
		});
		return;
	}
	busy = true;
	try {
		const parsed = JSON.parse((await readBody(req)) || "{}");
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		emit("message_start", { message: { id: "msg_mock", role: "assistant", model: modelId, content: [] } });
		emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		for (let i = 0; i < chunks; i++) {
			await sleep(latencyMs);
			emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: `chunk${i} ` } });
		}
		emit("content_block_stop", { index: 0 });
		emit("message_delta", { delta: { stop_reason: "end_turn" } });
		emit("message_stop", {});
		res.end();
	} catch (error) {
		sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: String(error) } });
	} finally {
		busy = false;
	}
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${port}`);
	if (req.method === "GET" && url.pathname === "/health") {
		sendJson(res, 200, { status: "ok", model: modelId, busy });
		return;
	}
	if (req.method === "GET" && url.pathname === "/v1/models") {
		sendJson(res, 200, { object: "list", data: [{ id: modelId, object: "model", owned_by: "colibri" }] });
		return;
	}
	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
		openaiChat(req, res);
		return;
	}
	if (req.method === "POST" && url.pathname === "/v1/messages") {
		anthropicMessages(req, res);
		return;
	}
	sendJson(res, 404, { error: { message: `no route: ${req.method} ${url.pathname}` } });
});

server.listen(port, () => {
	console.log(`mock colibri listening on http://localhost:${port} (model: ${modelId})`);
});
