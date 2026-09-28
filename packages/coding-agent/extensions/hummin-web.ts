/**
 * hummin-web: web_search + web_fetch for the local fleet.
 *
 * - web_search: DuckDuckGo Lite HTML scrape (no API key, no tracking).
 * - web_fetch: GET with user-agent, size cap, timeout, and an SSRF guard
 *   that rejects private/loopback/link-local targets.
 *
 * Both tools are read-only and count against the guardrail tool budget.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USER_AGENT = "hummin/0.1 (+local coding agent)";
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5_000_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_REDIRECTS = 5;

function decodeEntities(text: string): string {
	return text
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&#x2F;/g, "/");
}

function stripTags(html: string): string {
	return decodeEntities(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
	if (classifyIp(host) === "blocked") return true;
	return false;
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

/**
 * Decode non-canonical IPv4 literals to dotted-quad form, or null when the
 * string is not an IPv4 literal. Covers what URL parsers and inet_aton accept
 * but a regex for `\d+\.\d+\.\d+\.\d+` misses: pure decimal (`2130706433`),
 * hex (`0x7f000001`), and shorthand dotted forms (`127.1`), all of which
 * resolve to loopback/private space and used to slip past the fetch guard.
 */
export function decodeIpLiteral(host: string): string | null {
	const h = host.trim().toLowerCase().replace(/\.$/, "");
	if (!h || h.includes(":")) return null;
	const parsePart = (s: string): number | null => {
		if (/^\d{1,10}$/.test(s)) return Number(s);
		if (/^0x[0-9a-f]{1,8}$/.test(s)) return parseInt(s.slice(2), 16);
		return null;
	};
	if (!h.includes(".")) {
		const value = parsePart(h);
		if (value === null || value > 0xffffffff) return null;
		return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
	}
	const parts = h.split(".");
	if (parts.length > 4) return null;
	const nums: number[] = [];
	for (const part of parts) {
		const parsed = parsePart(part);
		if (parsed === null) return null;
		nums.push(parsed);
	}
	// Non-final parts must be plain octets; hex is only valid in the final part.
	for (let i = 0; i < nums.length - 1; i++) {
		if (nums[i]! > 255 || /^0x/.test(parts[i]!)) return null;
	}
	const head = nums.slice(0, -1);
	const tail = nums[nums.length - 1]!;
	const tailOctets = 4 - head.length;
	if (tail >= 2 ** (8 * tailOctets)) return null;
	const tailBytes: number[] = [];
	for (let i = tailOctets - 1; i >= 0; i--) tailBytes.push((tail >>> (8 * i)) & 0xff);
	return [...head, ...tailBytes].join(".");
}

function classifyDotted(ip: string): "blocked" | "public" {
	const value = ipv4ToInt(ip);
	if (value === null) return "public";
	const a = (value >>> 24) & 0xff;
	const b = (value >>> 16) & 0xff;
	const c = (value >>> 8) & 0xff;
	if (a === 0 || a === 10 || a === 127) return "blocked"; // this-network, private, loopback
	if (a === 169 && b === 254) return "blocked"; // link-local
	if (a === 172 && b >= 16 && b <= 31) return "blocked"; // private
	if (a === 192 && b === 168) return "blocked"; // private
	if (a === 100 && b >= 64 && b <= 127) return "blocked"; // CGNAT
	if (a === 198 && (b === 18 || b === 19)) return "blocked"; // benchmarking
	if (a === 192 && b === 0 && c === 2) return "blocked"; // TEST-NET-1
	if (a >= 224) return "blocked"; // multicast and reserved
	return "public";
}

/**
 * Pure: "blocked" when an address (dotted quad, encoded literal, or IPv6
 * string) is private, reserved, loopback, or otherwise unreachable from the
 * public internet. Used on DNS answers so a public hostname that resolves to
 * private space is rejected, not just private-literal URLs.
 */
export function classifyIp(ip: string): "blocked" | "public" {
	const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (raw.includes(":")) {
		if (raw === "::" || raw === "::1") return "blocked"; // unspecified, loopback
		if (raw.startsWith("::ffff:")) {
			const mapped = raw.slice(7);
			if (mapped.includes(".")) return classifyDotted(decodeIpLiteral(mapped) ?? mapped);
		}
		if (raw.startsWith("64:ff9b:")) return "blocked"; // NAT64 toward IPv4
		if (raw.startsWith("2001:db8:")) return "blocked"; // documentation
		const first = Number.parseInt(raw.split(":")[0] ?? "", 16);
		if (Number.isFinite(first)) {
			if ((first & 0xfe00) === 0xfc00) return "blocked"; // unique local fc00::/7
			if ((first & 0xffc0) === 0xfe80) return "blocked"; // link-local fe80::/10
		}
		return "public";
	}
	const dotted = decodeIpLiteral(raw);
	if (dotted) return classifyDotted(dotted);
	return classifyDotted(raw);
}

/**
 * Full host validation for one fetch hop: string checks (fast path), then DNS
 * resolution with every resolved address classified, so hostnames that answer
 * with private addresses (DNS rebinding, *.localtest.me) are rejected too.
 */
async function assertPublicHost(url: URL): Promise<void> {
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (isBlockedHost(host)) {
		throw new Error(`Blocked host (private/loopback network): ${url.hostname}`);
	}
	let addresses: ReadonlyArray<{ address: string }>;
	try {
		addresses = await dnsLookup(host, { all: true });
	} catch {
		throw new Error(`Cannot resolve host: ${url.hostname}`);
	}
	if (addresses.length === 0) {
		throw new Error(`Cannot resolve host: ${url.hostname}`);
	}
	for (const { address } of addresses) {
		if (classifyIp(address) === "blocked") {
			throw new Error(`Blocked host (${url.hostname} resolves to a private/loopback address: ${address})`);
		}
	}
}

/** String-level gate for one URL: scheme check plus the private-host fast
 * path. DNS answers are validated separately in assertPublicHost. */
export function assertFetchable(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Only http(s) URLs are supported, got: ${url.protocol}`);
	}
	if (isBlockedHost(url.hostname)) {
		throw new Error(`Blocked host (private/loopback network): ${url.hostname}`);
	}
	return url;
}

/** Bounded body read: the stream is capped even when no content-length is
 * declared, so an oversized response cannot balloon memory. */
async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > maxBytes) {
		throw new Error(`Response too large: ${declared} bytes (cap ${maxBytes})`);
	}
	if (!response.body) return await response.text();
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`Response too large: exceeded ${maxBytes} bytes while streaming (cap ${maxBytes})`);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

interface FetchedPage {
	url: URL;
	status: number;
	contentType: string;
	body: string;
}

/**
 * GET with the SSRF guard applied per hop: redirects are followed manually
 * (max MAX_REDIRECTS) and every destination is re-validated by hostname and
 * by its DNS answers, so a public URL cannot bounce a fetch into loopback or
 * private space. The body is read with a hard byte cap.
 */
async function fetchPublicText(rawUrl: string, timeoutMs: number, maxBytes: number): Promise<FetchedPage> {
	let current = assertFetchable(rawUrl);
	for (let hop = 0; ; hop++) {
		if (hop > MAX_REDIRECTS) {
			throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
		}
		await assertPublicHost(current);
		const response = await fetch(current, {
			headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(`HTTP ${response.status} redirect without a Location header from ${current.hostname}`);
			}
			const next = new URL(location, current);
			if (next.protocol !== "http:" && next.protocol !== "https:") {
				throw new Error(`Refusing redirect to non-http(s) URL: ${next.protocol}`);
			}
			current = next;
			continue;
		}
		const body = await readCappedBody(response, maxBytes);
		return { url: current, status: response.status, contentType: response.headers.get("content-type") ?? "", body };
	}
}


// Structure-preserving HTML-to-text: headings become markdown headers,
// http(s) links become [text](href), list items become "- " lines - the
// model reads page structure, not just a word salad.
function inlineFrom(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
	const cleaned = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[^>]*-->/g, " ");
	return decodeEntities(
		cleaned
			.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inlineFrom(inner)}\n`)
			.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inlineFrom(inner)}`)
			.replace(
				/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
				(_m, href: string, inner: string) => {
					const label = inlineFrom(inner);
					return label ? `[${label}](${href})` : "";
				},
			)
			.replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/table|\/ul|\/ol)[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function capOutput(text: string, maxChars: number = MAX_OUTPUT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated: output exceeded ${maxChars} chars]`;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

async function webSearch(query: string): Promise<SearchResult[]> {
	const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
		headers: { "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
	const html = await response.text();

	const results: SearchResult[] = [];
	const linkPattern = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippets = [...html.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
	let match: RegExpExecArray | null;
	let index = 0;
	while ((match = linkPattern.exec(html)) !== null && index < 8) {
		let url = decodeEntities(match[1]);
		const uddg = url.match(/[?&]uddg=([^&]+)/);
		if (uddg) url = decodeURIComponent(uddg[1]);
		const title = stripTags(match[2]);
		if (!title || !/^https?:\/\//.test(url)) continue;
		results.push({ title, url, snippet: snippets[index] ?? "" });
		index++;
	}
	return results;
}

export default function humminWeb(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web (DuckDuckGo, no API key). Returns up to 8 results with title, URL, and snippet. Use before web_fetch when you need to find sources.",
		promptSnippet: "web_search: search the web via DuckDuckGo (returns titles, URLs, snippets)",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
		async execute(_toolCallId, params): Promise<{ content: [{ type: "text"; text: string }]; details: { count: number }; isError?: boolean }> {
			if (!params.query.trim()) {
				return { content: [{ type: "text", text: "Error: empty query" }], details: { count: 0 }, isError: true };
			}
			const results = await webSearch(params.query);
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No results found." }], details: { count: 0 } };
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n\n");
			return { content: [{ type: "text", text: capOutput(text) }], details: { count: results.length } };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a public http(s) URL and return its content as text. HTML keeps headings (#), links ([text](url)) and lists (-) so page structure survives. Private and loopback hosts are blocked, including via DNS answers and redirect hops; responses are size-capped.",
		promptSnippet: "web_fetch: fetch a public URL and return its text content",
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch" }),
			max_chars: Type.Optional(
				Type.Number({ description: "Output character cap (default 20000)" }),
			),
		}),
		async execute(_toolCallId, params): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }> {
			const maxChars = typeof params.max_chars === "number" && params.max_chars > 0 ? Math.floor(params.max_chars) : MAX_OUTPUT_CHARS;
			const page = await fetchPublicText(params.url, FETCH_TIMEOUT_MS, MAX_BYTES);
			const body = page.body;
			if (page.status >= 400) {
				throw new Error(`HTTP ${page.status} from ${page.url.hostname}: ${body.slice(0, 200)}`);
			}
			const text =
				page.contentType.includes("html") || /^\s*<!doctype html|<html/i.test(body)
					? htmlToText(body)
					: body;
			const meta = `[url: ${page.url.href} | status: ${page.status} | type: ${page.contentType || "unknown"}]`;
			return { content: [{ type: "text", text: capOutput(`${meta}\n\n${text}`, maxChars) }], details: {} };
		},
	});
}
