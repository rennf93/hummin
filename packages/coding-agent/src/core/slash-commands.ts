import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
	category?: string;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	category?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu", category: "Settings" },
	{
		name: "model",
		description: "Select model (opens selector UI)",
		argumentHint: "<provider/model>",
		category: "Models",
	},
	{ name: "tree", description: "Navigate session tree (switch branches)", category: "Session" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>", category: "Models" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", category: "Models" },
	{
		name: "export",
		description: "Export session (Markdown default, or specify path: .md/.html/.jsonl)",
		category: "Session",
	},
	{ name: "import", description: "Import and resume a session from a JSONL file", category: "Session" },
	{ name: "share", description: "Share session as a secret GitHub gist", category: "Tools" },
	{ name: "copy", description: "Copy last agent message to clipboard", category: "Tools" },
	{ name: "name", description: "Set session display name", category: "Session" },
	{ name: "session", description: "Show session info and stats", category: "Session" },
	{ name: "changelog", description: "Show changelog entries", category: "Tools" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", category: "Settings" },
	{ name: "fork", description: "Create a new fork from a previous user message", category: "Session" },
	{ name: "clone", description: "Duplicate the current session at the current position", category: "Session" },
	{ name: "trust", description: "Save project trust decision for future sessions", category: "Settings" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>", category: "Models" },
	{ name: "logout", description: "Remove provider authentication", category: "Models" },
	{ name: "clear", description: "Start a new session", category: "Session" },
	{ name: "compact", description: "Manually compact the session context", category: "Session" },
	{ name: "resume", description: "Resume a different session", category: "Session" },
	{
		name: "reload",
		description: "Reload keybindings, extensions, skills, prompts, themes, and context files",
		category: "Settings",
	},
	{ name: "quit", description: `Quit ${APP_NAME}`, category: "Session" },
];
