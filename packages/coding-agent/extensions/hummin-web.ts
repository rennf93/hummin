/**
 * hummin-web: web_search + web_fetch for the local fleet.
 *
 * - web_search: DuckDuckGo Lite HTML scrape (no API key, no tracking).
 * - web_fetch: GET with user-agent, size cap, timeout, and an SSRF guard
 *   that rejects private/loopback/link-local targets.
 *
 * Both tools are read-only and count against the guardrail tool budget.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USER_AGENT = "hummin/0.1 (+local coding agent)";
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5_000_000;
const MAX_OUTPUT_CHARS = 20_000;

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
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a >= 224) return true;
	}
	return false;
}

function assertFetchable(rawUrl: string): URL {
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

function capOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: output exceeded ${MAX_OUTPUT_CHARS} chars]`;
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
		async execute(_toolCallId, params) {
			if (!params.query.trim()) {
				return { content: [{ type: "text", text: "Error: empty query" }], isError: true };
			}
			const results = await webSearch(params.query);
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No results found." }] };
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n\n");
			return { content: [{ type: "text", text: capOutput(text) }] };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a public http(s) URL and return its content as text (HTML is converted to plain text, 20K char cap). Blocked for private/loopback hosts.",
		promptSnippet: "web_fetch: fetch a public URL and return its text content",
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch" }),
		}),
		async execute(_toolCallId, params) {
			const url = assertFetchable(params.url);
			const response = await fetch(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const contentType = response.headers.get("content-type") ?? "";
			const declared = Number(response.headers.get("content-length") ?? 0);
			if (declared > MAX_BYTES) {
				throw new Error(`Response too large: ${declared} bytes (cap ${MAX_BYTES})`);
			}
			const body = await response.text();
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} from ${url.hostname}: ${body.slice(0, 200)}`);
			}
			const text =
				contentType.includes("html") || /^\s*<!doctype html|<html/i.test(body)
					? stripTags(body)
					: body;
			const meta = `[url: ${url.href} | status: ${response.status} | type: ${contentType || "unknown"}]`;
			return { content: [{ type: "text", text: capOutput(`${meta}\n\n${text}`) }] };
		},
	});
}
