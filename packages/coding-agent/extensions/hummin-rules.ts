/** Path-scoped project rules: .hummin/rules/*.md, Claude-Code-style.
 *
 * A rule file is Markdown with optional frontmatter:
 *
 *   ---
 *   paths: ["src/**", "*.md"]   # glob(s); omit for always-apply
 *   description: one-line summary
 *   ---
 *   rule body ...
 *
 * Always-apply rules are injected into context once per session on the first
 * turn. Path-scoped rules are advertised as a catalog on the first turn and
 * their bodies are delivered lazily (steer) the first time a tool call touches
 * a matching path, so rarely-hit rule bodies never occupy context.
 *
 * Limitation: only tool inputs with a `path` field (read/edit/write/grep/find/
 * ls and custom tools) trigger delivery. Shell commands are deliberately not
 * parsed for paths - false positives would be worse than missing a rule.
 */
import { basename, isAbsolute, join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

const RULES_DIR = `${CONFIG_DIR_NAME}/rules`;
const LOADED_MARKER = "hummin-rules-loaded";
const MESSAGE_TYPE = "hummin-rules";

export interface ProjectRule {
	/** File name without .md. */
	name: string;
	/** Glob patterns relative to the project root; empty = always apply. */
	paths: string[];
	description: string;
	body: string;
}

/** Minimal frontmatter subset: `key: value`, inline arrays, and block lists.
 * No YAML dependency; rules files are hand-authored and simple. */
export function parseFrontmatter(raw: string): { paths: string[]; description: string; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { paths: [], description: "", body: raw.trim() };
	const paths: string[] = [];
	let description = "";
	let inPathsBlock = false;
	for (const line of match[1]!.split(/\r?\n/)) {
		if (/^\s*-\s+/.test(line) && inPathsBlock) {
			paths.push(line.replace(/^\s*-\s+/, "").trim());
			continue;
		}
		inPathsBlock = false;
		const pair = line.match(/^(\w+)\s*:\s*(.*)$/);
		if (!pair) continue;
		const [, key, value] = pair as [string, string, string];
		if (key === "paths") {
			if (value.startsWith("[")) {
				paths.push(...value.replace(/^\[|\]$/g, "").split(",").map((p) => p.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
			} else if (value) {
				paths.push(value.trim().replace(/^["']|["']$/g, ""));
			} else {
				inPathsBlock = true;
			}
		} else if (key === "description") {
			description = value.trim().replace(/^["']|["']$/g, "");
		}
	}
	return { paths, description, body: raw.slice(match[0]!.length).trim() };
}

export function loadRules(dir: string): ProjectRule[] {
	if (!existsSync(dir)) return [];
	const rules: ProjectRule[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		try {
			const parsed = parseFrontmatter(readFileSync(join(dir, entry), "utf8"));
			if (!parsed.body) continue;
			rules.push({
				name: entry.replace(/\.md$/, ""),
				paths: parsed.paths,
				description: parsed.description,
				body: parsed.body,
			});
		} catch {
			// unreadable rule file: skip it rather than fail the session
		}
	}
	return rules;
}

/** Match a project-relative or absolute file path against one glob. Patterns
 * without a slash match the basename at any depth (Claude-Code-style). */
function matchesGlob(relPath: string, absPath: string, baseName: string, pattern: string): boolean {
	if (!pattern.includes("/")) return minimatch(baseName, pattern, { dot: true });
	return minimatch(relPath, pattern, { dot: true }) || minimatch(absPath, pattern, { dot: true });
}

export function pathMatchesRule(rule: ProjectRule, filePath: string, cwd: string): boolean {
	const abs = isAbsolute(filePath) ? filePath : join(cwd, filePath);
	const rel = relative(cwd, abs);
	const baseName = basename(abs);
	return rule.paths.some((pattern) => matchesGlob(rel, abs, baseName, pattern));
}

/** Tool inputs that carry file paths. Shell commands are excluded on purpose. */
export function inputPaths(input: Record<string, unknown>): string[] {
	const value = input.path;
	return typeof value === "string" && value.length > 0 ? [value] : [];
}

export function ruleMessage(rule: ProjectRule): string {
	const scope = rule.paths.length > 0 ? ` (paths: ${rule.paths.join(", ")})` : "";
	return `[Rule: ${rule.name}]${scope}\n${rule.body}`;
}

export function buildFirstTurnMessage(rules: ProjectRule[]): string | undefined {
	const always = rules.filter((rule) => rule.paths.length === 0);
	const scoped = rules.filter((rule) => rule.paths.length > 0);
	const parts: string[] = [];
	if (always.length > 0) {
		parts.push(always.map((rule) => ruleMessage(rule)).join("\n\n"));
	}
	if (scoped.length > 0) {
		const catalog = scoped
			.map((rule) => `- ${rule.name} (${rule.paths.join(", ")})${rule.description ? `: ${rule.description}` : ""}`)
			.join("\n");
		parts.push(
			`Path-scoped rules in ${RULES_DIR}/ apply when you touch matching files. Their full text is delivered automatically on first touch; keep them in mind for relevant work:\n${catalog}`,
		);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export default async function humminRulesExtension(pi: ExtensionAPI): Promise<void> {
	const delivered = new Set<string>();
	let cachedRules: ProjectRule[] | undefined;
	let cachedDir: string | undefined;

	const rulesFor = (cwd: string): ProjectRule[] => {
		const dir = join(cwd, RULES_DIR);
		if (cachedDir !== dir || !cachedRules) {
			cachedDir = dir;
			cachedRules = loadRules(dir);
		}
		return cachedRules;
	};

	pi.on("session_start", () => {
		delivered.clear();
		cachedRules = undefined;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const rules = rulesFor(ctx.cwd);
		if (rules.length === 0) return;
		const marker = ctx.sessionManager.getEntries().find(
			(entry) => entry.type === "custom" && entry.customType === LOADED_MARKER,
		);
		if (marker) return;
		pi.appendEntry(LOADED_MARKER, { version: 1 });
		const message = buildFirstTurnMessage(rules);
		if (!message) return;
		return {
			message: {
				customType: MESSAGE_TYPE,
				content: [{ type: "text", text: message }] satisfies TextContent[],
				display: false,
			},
		};
	});

	pi.on("tool_call", (event, ctx) => {
		const rules = rulesFor(ctx.cwd);
		if (rules.length === 0) return;
		const pending = rules.filter((rule) => rule.paths.length > 0 && !delivered.has(rule.name));
		if (pending.length === 0) return;
		for (const filePath of inputPaths(event.input)) {
			for (const rule of pending) {
				if (delivered.has(rule.name)) continue;
				if (!pathMatchesRule(rule, filePath, ctx.cwd)) continue;
				delivered.add(rule.name);
				void pi.sendMessage({
					customType: MESSAGE_TYPE,
					content: ruleMessage(rule),
					display: false,
				}, { deliverAs: "steer" });
				ctx.ui?.notify(`rules: ${rule.name} applied`, "info");
			}
		}
	});
}
