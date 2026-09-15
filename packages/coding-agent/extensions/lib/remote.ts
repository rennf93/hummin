import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { REMOTE_PAGE } from "./remote-page.ts";

export interface RemoteActions {
	state: () => unknown;
	prompt: (text: string) => void;
	abort: () => void;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	let bytes = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > 16_384) throw new Error("Request too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Loopback-only control endpoint. Use an authenticated SSH tunnel for other
 * devices. Capability tokens live in URL fragments, never HTTP URLs or logs. */
export async function startRemoteControl(actions: RemoteActions, port = 0) {
	const token = randomBytes(32).toString("hex");
	const accepted = new Map<string, string>();
	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		const reply = (status: number, body: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(body));
		};
		const host = request.headers.host ?? "";
		if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
			reply(403, { error: "Invalid host" });
			return;
		}
		if (request.headers.origin && request.headers.origin !== `http://${host}`) {
			reply(403, { error: "Invalid origin" });
			return;
		}
		if (request.method === "GET" && request.url === "/") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(REMOTE_PAGE);
			return;
		}
		const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (
			Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
			!timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
		) {
			reply(401, { error: "Invalid access token" });
			return;
		}
		try {
			if (request.method === "GET" && request.url === "/state") {
				reply(200, actions.state());
				return;
			}
			if (request.method !== "POST" || !["/prompt", "/abort"].includes(request.url ?? "")) {
				reply(404, { error: "Unknown endpoint" });
				return;
			}
			if (request.headers["content-type"] !== "application/json") {
				reply(415, { error: "Expected application/json" });
				return;
			}
			const body = await readBody(request);
			if (
				!body ||
				typeof body !== "object" ||
				!("id" in body) ||
				typeof body.id !== "string" ||
				!/^[a-zA-Z0-9-]{1,80}$/.test(body.id)
			) {
				reply(400, { error: "Request ID required" });
				return;
			}
			const signature = JSON.stringify([request.url, body]);
			const previous = accepted.get(body.id);
			if (previous) {
				reply(previous === signature ? 200 : 409, { accepted: previous === signature });
				return;
			}
			if (request.url === "/prompt") {
				if (!("text" in body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 12_000) {
					reply(400, { error: "Prompt must contain 1–12000 characters" });
					return;
				}
				actions.prompt(body.text);
			} else actions.abort();
			accepted.set(body.id, signature);
			if (accepted.size > 256) accepted.delete(accepted.keys().next().value!);
			reply(202, { accepted: true });
		} catch (error) {
			reply(400, { error: String(error) });
		}
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.maxConnections = 8;
	server.setTimeout(10_000, (socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Remote listener has no address");
	return {
		url: `http://127.0.0.1:${address.port}/#${token}`,
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}
