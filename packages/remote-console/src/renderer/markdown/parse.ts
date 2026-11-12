/**
 * renderer/markdown/parse: pure markdown parser for the remote console transcript,
 * structured on the dashboard's streaming-tolerant markdown.jsx with nested lists,
 * tables, blockquotes, and safe autolinks added. Safety is structural, not filtered:
 * there is no HTML pass-through, so any markup the parser does not recognize stays
 * literal text and the React layer escapes every string it emits. The parser is
 * bounded by construction: an unclosed fence consumes to end of input and every
 * loop advances the line cursor, so hostile input cannot hang it.
 */

export interface MdTextSpan {
	kind: "text";
	text: string;
}

export interface MdCodeSpan {
	kind: "code";
	text: string;
}

export interface MdStrongSpan {
	kind: "strong";
	spans: MdSpan[];
}

export interface MdEmSpan {
	kind: "em";
	spans: MdSpan[];
}

export interface MdDelSpan {
	kind: "del";
	spans: MdSpan[];
}

/** Link with a scheme-checked href; unsafe targets never become links. */
export interface MdLinkSpan {
	kind: "link";
	href: string;
	text: string;
}

/** Autolink: bare URL, www URL, angle-bracketed URL, or email. */
export interface MdAutolinkSpan {
	kind: "autolink";
	href: string;
}

export type MdSpan = MdTextSpan | MdCodeSpan | MdStrongSpan | MdEmSpan | MdDelSpan | MdLinkSpan | MdAutolinkSpan;

export interface MdHeading {
	kind: "heading";
	level: number;
	spans: MdSpan[];
}

export interface MdParagraph {
	kind: "paragraph";
	spans: MdSpan[];
}

export interface MdCode {
	kind: "code";
	language: string;
	code: string;
	/** False when the input ended inside the fence; rendered with an honest notice. */
	closed: boolean;
}

export interface MdQuote {
	kind: "quote";
	blocks: MdBlock[];
}

export interface MdListItem {
	task: "checked" | "unchecked" | null;
	blocks: MdBlock[];
}

export interface MdList {
	kind: "list";
	ordered: boolean;
	start: number;
	items: MdListItem[];
}

export interface MdTable {
	kind: "table";
	align: ("left" | "center" | "right" | null)[];
	head: MdSpan[][];
	rows: MdSpan[][][];
}

export interface MdRule {
	kind: "rule";
}

export type MdBlock = MdHeading | MdParagraph | MdCode | MdQuote | MdList | MdTable | MdRule;

interface FenceOpen {
	char: string;
	length: number;
	info: string;
}

interface ListItemMatch {
	indent: number;
	ordered: boolean;
	number: number;
	text: string;
}

interface ListProgress {
	task: "checked" | "unchecked" | null;
	contentLines: string[];
}

/** Only http, https, and mailto pass; every other scheme (javascript:, data:, ...) renders as text. */
function isSafeHref(href: string): boolean {
	return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

/** Parses one markdown text block into a block tree. */
export function parseMarkdown(text: string): MdBlock[] {
	return parseBlocks(text.split("\n"));
}

function parseBlocks(lines: readonly string[]): MdBlock[] {
	const blocks: MdBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim() === "") {
			i++;
			continue;
		}
		const fence = matchFenceOpen(line);
		if (fence !== null) {
			const [block, next] = consumeFence(lines, i, fence);
			blocks.push(block);
			i = next;
			continue;
		}
		const heading = matchHeading(line);
		if (heading !== null) {
			blocks.push(heading);
			i++;
			continue;
		}
		if (matchRule(line)) {
			blocks.push({ kind: "rule" });
			i++;
			continue;
		}
		if (matchQuote(line)) {
			const [block, next] = consumeQuote(lines, i);
			blocks.push(block);
			i = next;
			continue;
		}
		if (matchListItem(line) !== null) {
			const [block, next] = consumeList(lines, i);
			blocks.push(block);
			i = next;
			continue;
		}
		if (isTableStart(lines, i)) {
			const [block, next] = consumeTable(lines, i);
			blocks.push(block);
			i = next;
			continue;
		}
		const [block, next] = consumeParagraph(lines, i);
		blocks.push(block);
		i = next;
	}
	return blocks;
}

function matchFenceOpen(line: string): FenceOpen | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (match === null) return null;
	const marker = match[1] ?? "";
	const info = (match[2] ?? "").trim();
	if (marker.startsWith("`") && info.includes("`")) return null;
	return { char: marker[0] ?? "`", length: marker.length, info };
}

function fenceClosePattern(char: string, length: number): RegExp {
	return char === "`" ? new RegExp(`^\`{${length},}$`) : new RegExp(`^~{${length},}$`);
}

function consumeFence(lines: readonly string[], start: number, open: FenceOpen): [MdCode, number] {
	const closePattern = fenceClosePattern(open.char, open.length);
	const code: string[] = [];
	let i = start + 1;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (closePattern.test(line.trim())) {
			return [{ kind: "code", language: languageOf(open.info), code: code.join("\n"), closed: true }, i + 1];
		}
		code.push(line);
		i++;
	}
	// Unclosed fence: everything to end of input is code. The loop above always advances,
	// so hostile input cannot hang the parser here.
	return [{ kind: "code", language: languageOf(open.info), code: code.join("\n"), closed: false }, i];
}

function languageOf(info: string): string {
	if (info === "") return "";
	const first = info.split(/\s+/)[0] ?? "";
	return first.toLowerCase();
}

function matchHeading(line: string): MdHeading | null {
	const match = /^(#{1,6})\s+(.+)$/.exec(line.trimEnd());
	if (match === null) return null;
	const hashes = match[1] ?? "";
	const body = (match[2] ?? "").replace(/\s+#+\s*$/, "");
	return { kind: "heading", level: hashes.length, spans: parseInline(body) };
}

function matchRule(line: string): boolean {
	return /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line);
}

function matchQuote(line: string): boolean {
	return /^ {0,3}>/.test(line);
}

function consumeQuote(lines: readonly string[], start: number): [MdQuote, number] {
	const inner: string[] = [];
	let i = start;
	while (i < lines.length && matchQuote(lines[i] ?? "")) {
		inner.push((lines[i] ?? "").replace(/^ {0,3}> ?/, ""));
		i++;
	}
	return [{ kind: "quote", blocks: parseBlocks(inner) }, i];
}

const LIST_ITEM_PATTERN = /^( {0,3})([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;

function matchListItem(line: string): ListItemMatch | null {
	const match = LIST_ITEM_PATTERN.exec(line);
	if (match === null) return null;
	const indent = (match[1] ?? "").length;
	const marker = match[2] ?? "";
	const text = (match[3] ?? "").replace(/\s+$/, "");
	const ordered = /\d/.test(marker[0] ?? "");
	return { indent, ordered, number: ordered ? Number.parseInt(marker, 10) : 1, text };
}

function indentOf(line: string): number {
	const match = /^ */.exec(line);
	return match === null ? 0 : match[0].length;
}

function stripIndent(line: string, base: number): string {
	if (base === 0) return line;
	return line.replace(new RegExp(`^ {1,${base}}`), "");
}

function consumeList(lines: readonly string[], start: number): [MdList, number] {
	const first = matchListItem(lines[start] ?? "");
	if (first === null) return [{ kind: "list", ordered: false, start: 1, items: [] }, start + 1];
	const base = first.indent;
	const items: ListProgress[] = [];
	let current: ListProgress | null = null;
	let i = start;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim() === "") break;
		const item = matchListItem(line);
		if (item !== null) {
			if (item.indent < base) break;
			if (item.indent === base) {
				if (current !== null) items.push(current);
				current = startItem(item);
				i++;
				continue;
			}
		} else if (indentOf(line) <= base) {
			// Non-item text at or below the list's indent level ends the list.
			break;
		}
		// Indented lines (nested lists, paragraph continuations) belong to the open item.
		if (current === null) break;
		current.contentLines.push(stripIndent(line, base));
		i++;
	}
	if (current !== null) items.push(current);
	return [finishList(first, items), i];
}

function startItem(item: ListItemMatch): ListProgress {
	const task = /^\[([ xX])\]\s+/.exec(item.text);
	if (task === null) {
		return { task: null, contentLines: [item.text] };
	}
	const checked = (task[1] ?? "") !== " ";
	const body = item.text.slice(task[0].length);
	return { task: checked ? "checked" : "unchecked", contentLines: [body] };
}

function finishList(first: ListItemMatch, items: ListProgress[]): MdList {
	return {
		kind: "list",
		ordered: first.ordered,
		start: first.ordered ? first.number : 1,
		items: items.map((item) => ({
			task: item.task,
			blocks: parseBlocks(item.contentLines),
		})),
	};
}

function isTableDelim(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
	const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
	if (cells.length < 2) return false;
	return cells.every((cell) => /^ *:?-+:? *$/.test(cell));
}

function isTableStart(lines: readonly string[], index: number): boolean {
	if (!(lines[index] ?? "").includes("|")) return false;
	const next = lines[index + 1];
	return next !== undefined && isTableDelim(next);
}

function isTableAlignCell(cell: string): "left" | "center" | "right" | null {
	const match = /^ *(:?)-+(:?) *$/.exec(cell);
	if (match === null) return null;
	const left = match[1] === ":";
	const right = match[2] === ":";
	if (left && right) return "center";
	if (left) return "left";
	if (right) return "right";
	return null;
}

function splitRow(line: string): MdSpan[][] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => parseInline(cell.trim()));
}

function consumeTable(lines: readonly string[], start: number): [MdTable, number] {
	const delim = (lines[start + 1] ?? "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	const align = delim.map((cell) => isTableAlignCell(cell.trim()));
	const head = splitRow(lines[start] ?? "");
	const rows: MdSpan[][][] = [];
	let i = start + 2;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim() === "" || !line.includes("|")) break;
		rows.push(splitRow(line));
		i++;
	}
	return [{ kind: "table", align, head, rows }, i];
}

function startsBlock(line: string, next: string | undefined): boolean {
	if (matchFenceOpen(line) !== null) return true;
	if (matchHeading(line) !== null) return true;
	if (matchRule(line)) return true;
	if (matchQuote(line)) return true;
	if (matchListItem(line) !== null) return true;
	return next !== undefined && line.includes("|") && isTableDelim(next);
}

function consumeParagraph(lines: readonly string[], start: number): [MdParagraph, number] {
	const body: string[] = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim() === "" || startsBlock(line, lines[i + 1])) break;
		body.push(line);
		i++;
	}
	return [{ kind: "paragraph", spans: parseInline(body.join("\n")) }, i];
}

// Inline patterns ordered by priority: code, strong, del, em, links, then autolinks.
const INLINE_SOURCE = [
	"(`+[^`\\n]+`+)",
	"(\\*\\*[^*\\n]+\\*\\*)",
	"(~~[^~\\n]+~~)",
	"(\\*[^*\\n]+\\*)",
	"(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))",
	"(<(?:https?|mailto):[^\\s<>]+>)",
	"(\\bhttps?://[^\\s<>\"'`]+)",
	"(\\bwww\\.[^\\s<>\"'`]+)",
	// Domain must end in an alphabetic TLD, so package specs like name@1.7.0 stay text.
	"([\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)*\\.[A-Za-z]{2,}(?![\\w-]))",
].join("|");

/** Parses prose into inline spans. The regex is per-call because nested emphasis recurses
 * into parseInline and a shared lastIndex would corrupt the outer scan. */
function parseInline(text: string, depth = 0): MdSpan[] {
	const spans: MdSpan[] = [];
	const pattern = new RegExp(INLINE_SOURCE, "g");
	let last = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match.index > last) spans.push({ kind: "text", text: text.slice(last, match.index) });
		spans.push(...inlineSpans(match[0], depth));
		last = match.index + match[0].length;
		match = pattern.exec(text);
	}
	if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
	return spans;
}

function inlineSpans(token: string, depth: number): MdSpan[] {
	if (token.startsWith("`")) return [{ kind: "code", text: stripBackticks(token) }];
	if (token.startsWith("**")) return wrapSpans(token.slice(2, -2), depth, "strong");
	if (token.startsWith("~~")) return wrapSpans(token.slice(2, -2), depth, "del");
	if (token.startsWith("*")) return wrapSpans(token.slice(1, -1), depth, "em");
	const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
	if (link !== null) return [linkSpan(link[1] ?? "", link[2] ?? "")];
	if (token.startsWith("<")) return [{ kind: "autolink", href: token.slice(1, -1) }];
	const trimmed = trimTrailingPunctuation(token);
	if (trimmed.startsWith("www.")) return [{ kind: "autolink", href: `https://${trimmed}` }];
	if (trimmed.includes("@")) return [{ kind: "autolink", href: `mailto:${trimmed}` }];
	return [{ kind: "autolink", href: trimmed }];
}

function stripBackticks(token: string): string {
	let open = 0;
	while (open < token.length && token[open] === "`") open++;
	return token.slice(open, token.length - open);
}

function wrapSpans(inner: string, depth: number, kind: "strong" | "em" | "del"): MdSpan[] {
	// Depth guard keeps hostile nested emphasis input linear and bounded.
	const spans: MdSpan[] = depth < 2 ? parseInline(inner, depth + 1) : [{ kind: "text", text: inner }];
	return [{ kind, spans }];
}

function linkSpan(label: string, href: string): MdSpan {
	if (!isSafeHref(href)) {
		// Unsafe target: render as honest text instead of a link, destination visible.
		return { kind: "text", text: `${label} (${href})` };
	}
	return { kind: "link", href, text: label };
}

function trimTrailingPunctuation(url: string): string {
	let trimmed = url.replace(/[.,;:!?]+$/, "");
	while (trimmed.endsWith(")")) {
		const opens = (trimmed.match(/\(/g) ?? []).length;
		const closes = (trimmed.match(/\)/g) ?? []).length;
		if (closes <= opens) break;
		trimmed = trimmed.slice(0, -1);
	}
	return trimmed;
}
