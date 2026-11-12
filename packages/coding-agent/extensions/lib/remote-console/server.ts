/**
 * lib/remote-console/server: the remote console HTTP endpoint. Carries the
 * security perimeter of the old lib/remote.ts forward unchanged (token in the
 * URL fragment only, timing-safe bearer compare, host-header and origin
 * checks, no-store/nosniff/no-referrer, POST idempotency map, connection
 * caps) and extends it with the SSE stream, CORS for registered console
 * origins, and static serving of the built console.
 *
 * CSP choice (documented): the console build ships external hashed assets, so
 * the page needs `script-src 'self'; style-src 'self'` and no nonce; the
 * built-in fallback page has no scripts and its single style element carries
 * a per-load nonce. 'unsafe-inline' is never emitted.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { ApprovalRegistry } from "./approvals.ts";
import { ConsoleEventSource, MAX_STREAMS } from "./event-source.ts";
import type { ConsoleOriginStore } from "./store.ts";
import { isConsoleDistDir } from "./store.ts";

const MAX_BODY_BYTES = 65_536;
/** Action connection cap, on top of the stream cap. */
const MAX_ACTION_CONNECTIONS = 8;
const IDEMPOTENCY_CAP = 256;
const PROMPT_MAX_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 10_000;

const ASSET_TYPES: Record<string, string> = {
	".js": "text/javascript",
	".css": "text/css",
	".html": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
};

const POST_ENDPOINTS = ["/prompt", "/abort", "/approval", "/settings/console-origins"] as const;

export interface ConsoleActionHandlers {
	sendPrompt: (text: string, deliverAs: "steer" | "followUp") => void;
	abort: () => void;
}

export interface ConsoleServerOptions {
	token: string;
	host: string;
	/** Extra lowercase hostnames a fronting HTTPS proxy reaches this server by
	 * (Tailscale Serve, Caddy); accepted in the Host and Origin headers. */
	allowedHosts: readonly string[];
	/** The configured public origin, accepted even with an explicit port. */
	publicOrigin: string | undefined;
	port: number;
	source: ConsoleEventSource;
	approvals: ApprovalRegistry | undefined;
	origins: ConsoleOriginStore;
	/** Candidate dist directories, first containing an index.html wins. */
	distDirs: readonly string[];
	actions: ConsoleActionHandlers;
}

export interface ConsoleServerHandle {
	port: number;
	close: () => Promise<void>;
}

/** Loopback-first console server. The URL carries the token in its fragment;
 * it never appears in any response body or log. */
export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServerHandle> {
	const accepted = new Map<string, string>();
	const rememberAccepted = (id: string, signature: string): void => {
		accepted.set(id, signature);
		if (accepted.size > IDEMPOTENCY_CAP) {
			const oldest = accepted.keys().next();
			if (!oldest.done) accepted.delete(oldest.value);
		}
	};

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		const registry = options.origins.list();
		const origin = firstHeader(request.headers.origin);
		const host = firstHeader(request.headers.host) ?? "";
		if (!hostAllowed(host, options.host, options.allowedHosts)) {
			replyJson(response, 403, { error: "Invalid host" });
			return;
		}
		if (origin && !originAllowed(origin, host, registry, options.allowedHosts, options.publicOrigin)) {
			replyJson(response, 403, { error: "Invalid origin" });
			return;
		}
		// CORS for registered console origins: the actual responses of
		// cross-origin aggregation must echo the origin too, not just the
		// preflight. CORS is not the auth layer; the bearer token is.
		if (origin && registry.includes(origin)) {
			response.setHeader("Vary", "Origin");
			response.setHeader("Access-Control-Allow-Origin", origin);
		}
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "OPTIONS") {
			replyPreflight(response, origin, registry);
			return;
		}
		if (request.method === "GET" && path === "/events") {
			serveEvents(request, response);
			return;
		}
		if (request.method === "GET") {
			servePageOrAsset(path, response, registry, options.distDirs);
			return;
		}
		if (request.method === "POST") {
			await serveAction(path, request, response);
			return;
		}
		replyJson(response, 404, { error: "Unknown endpoint" });
	}

	function serveEvents(request: IncomingMessage, response: ServerResponse): void {
		if (!authenticated(request, options.token)) {
			replyJson(response, 401, { error: "Invalid access token" });
			return;
		}
		if (options.source.connectionCount() >= MAX_STREAMS) {
			replyJson(response, 503, { error: "Too many event streams" });
			return;
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		// Last-Event-ID header preferred over the ?cursor= query fallback.
		const cursor = parseCursor(firstHeader(request.headers["last-event-id"]) ?? url.searchParams.get("cursor"));
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		// SSE is exempt from the idle timeout: the 15s heartbeat keeps the
		// socket alive and the close listener cleans up dead streams.
		request.socket.setTimeout(0);
		options.source.attach(response, cursor);
	}

	async function serveAction(
		path: string,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		if (!(POST_ENDPOINTS as readonly string[]).includes(path)) {
			replyJson(response, 404, { error: "Unknown endpoint" });
			return;
		}
		if (!authenticated(request, options.token)) {
			replyJson(response, 401, { error: "Invalid access token" });
			return;
		}
		if (request.headers["content-type"] !== "application/json") {
			replyJson(response, 415, { error: "Expected application/json" });
			return;
		}
		const body: unknown = await readBody(request);
		if (!isActionBody(body) || !/^[a-zA-Z0-9-]{1,80}$/.test(body.id)) {
			replyJson(response, 400, { error: "Request ID required" });
			return;
		}
		const signature = JSON.stringify([path, body]);
		const previous = accepted.get(body.id);
		if (previous) {
			// Idempotent replay: identical body answers 200, a conflicting one 409.
			replyJson(response, previous === signature ? 200 : 409, { accepted: previous === signature });
			return;
		}
		if (path === "/prompt") {
			if (!("text" in body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > PROMPT_MAX_CHARS) {
				replyJson(response, 400, { error: `Prompt must contain 1 to ${PROMPT_MAX_CHARS} characters` });
				return;
			}
			options.actions.sendPrompt(body.text, "deliverAs" in body && body.deliverAs === "steer" ? "steer" : "followUp");
		} else if (path === "/abort") {
			options.actions.abort();
		} else if (path === "/approval") {
			if (!options.approvals) {
				replyJson(response, 501, { error: "Approvals not available" });
				return;
			}
			if (!("allow" in body) || typeof body.allow !== "boolean") {
				replyJson(response, 400, { error: "allow must be a boolean" });
				return;
			}
			const resolution = options.approvals.resolve(body.id, body.allow);
			if (resolution === "unknown") {
				replyJson(response, 404, { error: "No pending approval with that id" });
				return;
			}
			rememberAccepted(body.id, signature);
			replyJson(response, 202, { accepted: true, resolution });
			return;
		} else if (path === "/settings/console-origins") {
			if (!("origin" in body) || typeof body.origin !== "string") {
				replyJson(response, 400, { error: "origin must be a string" });
				return;
			}
			try {
				options.origins.add(body.origin);
			} catch (error) {
				replyJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
		}
		rememberAccepted(body.id, signature);
		replyJson(response, 202, { accepted: true });
	}

	const server: Server = createServer((request, response) => {
		try {
			void handleRequest(request, response).catch((error: unknown) => {
				// Carried over from remote.ts: handler errors answer 400 with the
				// message (read failures, malformed bodies).
				replyJson(response, 400, { error: String(error) });
			});
		} catch (error) {
			replyJson(response, 400, { error: String(error) });
		}
	});
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	server.headersTimeout = REQUEST_TIMEOUT_MS;
	// Idle-socket timeout for actions and pages; the SSE handler disables it
	// per socket (the heartbeat keeps those alive).
	server.setTimeout(REQUEST_TIMEOUT_MS, (socket) => socket.destroy());
	server.maxConnections = MAX_STREAMS + MAX_ACTION_CONNECTIONS;

	await listen(server, options.port, options.host);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Remote console listener has no address");

	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolvePromise, rejectPromise) => {
				server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
				server.closeAllConnections();
			}),
	};
}

/** First header value of a possibly-repeated header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value.at(-1) : value;
}

/** Host-header check, generalized from remote.ts for the LAN bind: the bound
 * host and the loopback names, and - for an any-interface bind, where every
 * local address is a valid reach name - any hostname - plus the configured
 * proxy hostnames. The bearer token remains the real gate. */
function hostAllowed(host: string, bindHost: string, allowedHosts: readonly string[]): boolean {
	if (!host) return false;
	if (bindHost === "0.0.0.0" || bindHost === "::") return true;
	const name = host.replace(/:\d+$/, "");
	if (allowedHosts.includes(name.toLowerCase())) return true;
	return name === bindHost || name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]";
}

/** Same-origin requests carry the request's own host; registry origins are
 * the console hosts the user added for fleet aggregation. A proxy may rewrite
 * Host to the loopback upstream while the browser still sends its public
 * origin, so origins on a configured proxy hostname are accepted too. */
function originAllowed(
	origin: string,
	host: string,
	 registry: readonly string[],
	allowedHosts: readonly string[],
	publicOrigin: string | undefined,
): boolean {
	if (origin === `http://${host}` || origin === `https://${host}`) return true;
	if (registry.includes(origin) || origin === publicOrigin) return true;
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	// port "" is the scheme's default port: a proxy fronts on 80/443, not an arbitrary local port
	return (
		(parsed.protocol === "https:" || parsed.protocol === "http:") &&
		parsed.port === "" &&
		allowedHosts.includes(parsed.hostname)
	);
}

/** CORS preflight. The allowlist is the console-origin registry, NOT an auth
 * surface: unauthenticated preflights still reflect registered origins (the
 * bearer token on the actual request is the auth layer). Allow-Credentials
 * is never emitted: auth is a header, not cookies. */
function replyPreflight(response: ServerResponse, origin: string | undefined, registry: readonly string[]): void {
	response.setHeader("Vary", "Origin");
	if (origin && registry.includes(origin)) {
		response.setHeader("Access-Control-Allow-Origin", origin);
		response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
		response.setHeader("Access-Control-Max-Age", "600");
	}
	response.writeHead(204);
	response.end();
}

/** Timing-safe bearer compare, same shape as remote.ts. */
function authenticated(request: IncomingMessage, token: string): boolean {
	const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
	return (
		Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
	);
}

/** Last-Event-ID header preferred over the query fallback; absent or
 * unparsable cursors mean "send a fresh snapshot". */
function parseCursor(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined || value.trim() === "") return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	let bytes = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) throw new Error("Request too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isActionBody(body: unknown): body is { id: string } {
	return (
		typeof body === "object" &&
		body !== null &&
		!Array.isArray(body) &&
		typeof (body as { id?: unknown }).id === "string"
	);
}

function replyJson(response: ServerResponse, status: number, body: unknown): void {
	response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(port, host, () => {
			server.removeListener("error", rejectPromise);
			resolvePromise();
		});
	});
}

/** Serve GET / (the console page) and static dist assets. Both are
 * unauthenticated: they carry no token material, like the old / page. Files
 * are read before the response starts so a missing or unreadable file answers
 * 404 instead of a mid-response failure. */
function servePageOrAsset(
	path: string,
	response: ServerResponse,
	registry: readonly string[],
	distDirs: readonly string[],
): void {
	const root = findDistRoot(distDirs);
	if (path === "/" || path === "/index.html") {
		if (root) {
			let page: Buffer;
			try {
				page = readFileSync(join(root, "index.html"));
			} catch {
				serveFallbackPage(response);
				return;
			}
			response.setHeader(
				"Content-Security-Policy",
				`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; connect-src 'self' ${registry.join(" ")}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
			);
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(page);
			return;
		}
		serveFallbackPage(response);
		return;
	}
	const asset = assetPath(root, path);
	if (!asset) {
		replyJson(response, 404, { error: "Unknown endpoint" });
		return;
	}
	let contents: Buffer;
	try {
		contents = readFileSync(asset);
	} catch {
		replyJson(response, 404, { error: "Unknown endpoint" });
		return;
	}
	response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
	response.writeHead(200, { "Content-Type": ASSET_TYPES[extname(asset)] ?? "application/octet-stream" });
	response.end(contents);
}

function serveFallbackPage(response: ServerResponse): void {
	const nonce = randomBytes(16).toString("base64");
	response.setHeader(
		"Content-Security-Policy",
		`default-src 'none'; script-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
	);
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hummin remote console</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font:15px/1.5 ui-monospace,monospace;background:#161918;color:#e4e8e6}
body{max-width:720px;margin:0 auto;padding:32px}code{color:#9cc8b9;overflow-wrap:anywhere}li{margin:6px 0}
</style>
<h1>hummin remote console</h1>
<p>The console build is not installed at this endpoint yet. This page is the
built-in fallback; it carries no access material. The access token arrives
only through the URL fragment of the full /remote-control URL.</p>
<ol>
<li>Build the console workspace package (<code>packages/remote-console</code>, <code>npm run build</code>).</li>
<li>Make its <code>dist/</code> visible to this server via <code>HUMMIN_REMOTE_CONSOLE_DIST</code>,
the workspace <code>packages/remote-console/dist</code>, or a seeded copy at
<code>&lt;agentDir&gt;/remote-console/dist</code>.</li>
<li>Reload this page.</li>
</ol>
</html>`);
}

function findDistRoot(dirs: readonly string[]): string | undefined {
	for (const dir of dirs) if (isConsoleDistDir(dir)) return dir;
	return undefined;
}

/** Resolve an asset path inside the dist root; undefined when it escapes
 * (traversal) or there is no dist root. */
function assetPath(root: string | undefined, path: string): string | undefined {
	if (!root) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		return undefined;
	}
	if (decoded.includes("..") || decoded.includes("\0")) return undefined;
	const resolved = resolve(root, `.${decoded}`);
	if (resolved !== root && !resolved.startsWith(root + sep)) return undefined;
	return resolved;
}
