/**
 * CLI `sessions` subcommand: list, show, and delete conversation sessions
 * entirely from the terminal. Resolves its own session directory via
 * `SessionManager` and exits, so it runs without the heavy interactive runtime.
 */

import chalk from "chalk";
import { unlinkSync } from "fs";
import { homedir } from "os";
import { sep } from "path";
import { createInterface } from "readline";
import { getSessionsDir } from "../config.ts";
import {
	type FileEntry,
	loadEntriesFromFile,
	type SessionInfo,
	SessionManager,
	type SessionMessageEntry,
} from "../core/session-manager.ts";

const DEFAULT_LIST_LIMIT = 50;

export const SESSIONS_USAGE = `${chalk.bold("hummin sessions")} <subcommand>

Manage conversation sessions from the terminal.

${chalk.bold("Usage:")}
  hummin sessions                 List recent sessions across all projects
  hummin sessions ls | list       Alias for listing sessions
  hummin sessions show <id>       Show details for a session
  hummin sessions rm <id>         Delete a session (alias: delete)
  hummin sessions <command> --help

${chalk.bold("Options:")}
  --all, -a             List sessions across all projects (default)
  --project, -C         List only sessions for the current project
  --limit <n>           Maximum number of sessions to show (default 50)
  --yes, -y             Skip the confirmation prompt when deleting
  --session-dir <dir>   Directory for session storage and lookup
`;

interface SessionCmdOptions {
	cwd?: string;
	sessionDir?: string;
}

/**
 * Handle the `sessions` subcommand. Returns true when the `sessions` keyword was
 * recognised so the caller can exit instead of falling through to interactive mode.
 */
export async function handleSessionsCommand(args: string[], options: SessionCmdOptions = {}): Promise<boolean> {
	// Extract the global --session-dir flag first, then strip it (and its
	// value) from the args so it does not leak into a subcommand's parsing.
	const sessionDir = extractOption(args, "--session-dir");
	const stripped = stripPair(args, "--session-dir");

	let [sub, ...rest] = stripped;
	// From the CLI, args start with the "sessions" keyword itself, so a real
	// subcommand follows it (e.g. ["sessions", "show", id]). Shift it up.
	if (sub === "sessions" && rest.length > 0 && !rest[0].startsWith("-")) {
		[sub, ...rest] = rest;
	}

	if (!sub || sub === "sessions") {
		if (rest.includes("-h") || rest.includes("--help")) {
			process.stdout.write(`${SESSIONS_USAGE}\n`);
			return true;
		}
		await listSessionsCommand(rest, options, sessionDir);
		return true;
	}

	switch (sub) {
		case "ls":
		case "list":
			await listSessionsCommand(rest, options, sessionDir);
			return true;
		case "show":
			await showSessionCommand(rest, sessionDir);
			return true;
		case "rm":
		case "delete":
		case "remove":
			await deleteSessionCommand(rest, sessionDir);
			return true;
		default:
			console.error(chalk.red(`Unknown sessions subcommand: ${sub}`));
			process.stdout.write(`${SESSIONS_USAGE}\n`);
			process.exitCode = 1;
			return true;
	}
}

function stripPair(args: string[], flag: string): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === flag && i + 1 < args.length) {
			i++; // skip the value
			continue;
		}
		if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) {
			continue;
		}
		result.push(arg);
	}
	return result;
}

function extractOption(args: string[], flag: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === flag && i + 1 < args.length) {
			return args[i + 1];
		}
		if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) {
			return arg.slice(flag.length + 1);
		}
	}
	return undefined;
}

async function listSessionsCommand(
	rest: string[],
	options: SessionCmdOptions,
	sessionDir: string | undefined,
): Promise<void> {
	let projectOnly = false;
	let limit = DEFAULT_LIST_LIMIT;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(`${SESSIONS_USAGE}\n`);
			return;
		} else if (arg === "--all" || arg === "-a") {
			projectOnly = false;
		} else if (arg === "--project" || arg === "-C") {
			projectOnly = true;
		} else if (arg === "--limit" && i + 1 < rest.length) {
			limit = Number(rest[++i]);
		} else if (arg.startsWith("--limit=")) {
			limit = Number(arg.slice("--limit=".length));
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "sessions".`));
			console.error(chalk.dim(`Use "hummin sessions --help"`));
			process.exitCode = 1;
			return;
		} else {
			console.error(chalk.red(`Unexpected argument ${arg} for "sessions" list.`));
			console.error(chalk.dim(`Use "hummin sessions --help"`));
			process.exitCode = 1;
			return;
		}
	}

	if (!Number.isFinite(limit) || limit <= 0) {
		console.error(chalk.red(`Invalid --limit value: ${limit}. Use a positive integer.`));
		process.exitCode = 1;
		return;
	}

	const cwd = options.cwd ?? process.cwd();
	const sessions = projectOnly ? await SessionManager.list(cwd, sessionDir) : await SessionManager.listAll(sessionDir);
	const visible = sessions.slice(0, limit);

	if (visible.length === 0) {
		console.log(chalk.dim("No sessions found."));
		return;
	}

	const rows = visible.map<SessionRow>((info) => ({
		rel: formatRelativeTime(info.modified),
		id: info.id.slice(0, 12),
		msgs: info.messageCount,
		name: info.name && info.name.length > 0 ? truncate(info.name, 32) : "(unnamed)",
		cwd: formatCwd(info.cwd),
	}));

	const columns: { header: string; render: (row: SessionRow) => string }[] = [
		{ header: "WHEN", render: (r) => chalk.dim(r.rel) },
		{ header: "ID", render: (r) => chalk.underline(r.id) },
		{ header: "MSGS", render: (r) => String(r.msgs).padStart(4) },
		{ header: "NAME", render: (r) => r.name },
		{ header: "PROJECT", render: (r) => r.cwd },
	];

	const widths = columns.map(({ header, render }) =>
		Math.max(header.length, ...rows.map((row) => stripColor(render(row)).length)),
	);

	console.log(
		columns
			.map(({ header }, index) => `${header.padEnd(widths[index])}  `)
			.join("")
			.trimEnd(),
	);
	for (const row of rows) {
		console.log(
			columns
				.map(({ render }, index) => `${pad(render(row), widths[index])}  `)
				.join("")
				.trimEnd(),
		);
	}

	const remaining = sessions.length - visible.length;
	if (remaining > 0) {
		console.log(chalk.dim(`… ${remaining} more (use --limit <n> or "hummin sessions show <id>")`));
	}
	console.log(chalk.dim(`Stored in: ${getSessionDirLabel(sessionDir)}`));
}

async function showSessionCommand(rest: string[], sessionDir: string | undefined): Promise<void> {
	if (rest.includes("-h") || rest.includes("--help")) {
		process.stdout.write(`${SESSIONS_USAGE}\n`);
		return;
	}

	const idArg = rest.find((arg) => !arg.startsWith("-"));
	if (!idArg) {
		console.error(chalk.red("show requires a session <id>."));
		console.error(chalk.dim(`Use "hummin sessions show --help"`));
		process.exitCode = 1;
		return;
	}

	const sessions = await SessionManager.listAll(sessionDir);
	const match = findMatch(sessions, idArg);
	if (!match) {
		console.error(chalk.red(`No session found matching "${idArg}"`));
		process.exitCode = 1;
		return;
	}

	console.log(`Session:  ${match.id}`);
	console.log(`Name:     ${match.name && match.name.length > 0 ? match.name : "(unnamed)"}`);
	console.log(`Created:  ${match.created.toUTCString()}`);
	console.log(`Modified: ${match.modified.toUTCString()}`);
	console.log(`Messages: ${match.messageCount}`);
	console.log(`CWD:      ${match.cwd}`);
	if (match.parentSessionPath) {
		console.log(`Parent:   ${basename(match.parentSessionPath)}`);
	}
	console.log(`File:     ${match.path}`);

	const entries = loadEntriesFromFile(match.path);
	const messages = entries.filter((entry) => isMessageEntry(entry));
	if (messages.length === 0) {
		console.log(`\n${chalk.dim("(no messages)")}`);
		return;
	}
	console.log(`\n${chalk.bold("Messages:")}`);
	for (const entry of messages.slice(-12)) {
		const entry_ = entry as SessionMessageEntry;
		const text = extractMessageText(entry_.message as { content?: unknown });
		const label = chalk.green(entry_.message.role);
		const preview = text.length > 0 ? text : chalk.dim("(no text)");
		console.log(`${label.padEnd(8)} ${truncate(preview, 100)}`);
	}
}

async function deleteSessionCommand(rest: string[], sessionDir: string | undefined): Promise<void> {
	if (rest.includes("-h") || rest.includes("--help")) {
		process.stdout.write(`${SESSIONS_USAGE}\n`);
		return;
	}

	let confirmed = false;
	for (const arg of rest) {
		if (arg === "-y" || arg === "--yes") {
			confirmed = true;
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "sessions" rm.`));
			console.error(chalk.dim(`Use "hummin sessions rm --help"`));
			process.exitCode = 1;
			return;
		}
	}

	const idArg = rest.find((arg) => !arg.startsWith("-"));
	if (!idArg) {
		console.error(chalk.red("rm requires a session <id>."));
		console.error(chalk.dim(`Use "hummin sessions rm --help"`));
		process.exitCode = 1;
		return;
	}

	const sessions = await SessionManager.listAll(sessionDir);
	const match = findMatch(sessions, idArg);
	if (!match) {
		console.error(chalk.red(`No session found matching "${idArg}"`));
		process.exitCode = 1;
		return;
	}

	if (!confirmed) {
		const ok = await promptConfirm(`Delete session ${match.id.slice(0, 12)} (${basename(match.path)})?`);
		if (!ok) {
			console.log(chalk.dim("Aborted."));
			return;
		}
	}

	try {
		unlinkSync(match.path);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Failed to delete ${match.path}: ${message}`));
		process.exitCode = 1;
		return;
	}

	console.log(chalk.green(`Deleted session ${match.id.slice(0, 12)}.`));
}

/**
 * Resolve a session id argument against a listing. Tries an exact match first
 * (for short ids <= 12 chars), then a prefix match, then a substring match,
 * mirroring the resolution used by the interactive runner.
 */
function findMatch(sessions: SessionInfo[], idArg: string): SessionInfo | undefined {
	// Short ids (<= 12 chars) only match exactly to avoid false prefixes.
	if (idArg.length <= 12) {
		const exact = sessions.find((session) => session.id === idArg);
		if (exact) return exact;
	}
	const prefix = sessions.find((session) => session.id.startsWith(idArg));
	return prefix ?? sessions.find((session) => session.id.includes(idArg));
}

function isMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function extractMessageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type?: unknown; text?: unknown } =>
					typeof block === "object" && block !== null && typeof block.type === "string",
			)
			.map((block) => block.text)
			.filter((text): text is string => typeof text === "string")
			.join(" ")
			.trim();
	}
	return "";
}

function formatRelativeTime(date: Date, now: number = Date.now()): string {
	const seconds = Math.floor((now - date.getTime()) / 1000);
	if (seconds < 45) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(months / 12);
	return `${years}y ago`;
}

function formatCwd(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}${sep}`)) return `~${cwd.slice(home.length)}`;
	return cwd.length > 40 ? `${cwd.slice(0, 40)}…` : cwd;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return value.slice(0, maxLength);
	return `${value.slice(0, maxLength - 1)}…`;
}

function stripColor(value: string): string {
	// ANSI escape sequences wrap rendered text; strip them to measure width.
	return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function pad(value: string, width: number): string {
	const text = stripColor(value);
	const padding = Math.max(0, width - text.length);
	// Preserve trailing color codes while padding the visible width.
	return text + " ".repeat(padding);
}

function basename(path: string): string {
	const index = path.lastIndexOf(sep);
	return index === -1 ? path : path.slice(index + 1);
}

function getSessionDirLabel(sessionDir: string | undefined): string {
	return sessionDir ?? getSessionsDir();
}

async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
		});
	});
}

interface SessionRow {
	rel: string;
	id: string;
	msgs: number;
	name: string;
	cwd: string;
}
