/**
 * hummin-confirm: asks Allow/Deny before risky bash steps. Built for the
 * desktop assistant: over RPC, ctx.ui.confirm becomes an extension_ui_request.
 *
 * Active only when `HUMMIN_CONFIRM=1`. read/edit/write tool calls never ask.
 * A denied step is blocked with `Renzo denied: <reason>`.
 *
 * Limits: text-level classification via bashguard's tokenizer, like bashguard
 * itself. Command substitution, eval, aliases, xargs, find -exec, bash -c
 * strings and ( ) / { } grouping are not analyzed; this is a
 * prompt for the human, not a security boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tokenize } from "./hummin-bashguard.ts";

const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);
const ELEVATORS = new Set(["sudo", "doas", "pkexec", "su"]);
const SIMPLE = new Set([
	"dd",
	"chown",
	"kill",
	"pkill",
	"killall",
	"shutdown",
	"reboot",
	"poweroff",
	"nixos-rebuild",
	"nix-env",
]);
const SHELLS = new Set(["sh", "bash"]);

/** Split on unquoted | ; & and newlines; `piped` marks segments fed by a `|`. */
function segments(raw: string): { text: string; piped: boolean }[] {
	const out: { text: string; piped: boolean }[] = [];
	let cur = "";
	let quote: string | undefined;
	let piped = false;
	const push = (nextPiped: boolean) => {
		if (cur.trim()) out.push({ text: cur, piped });
		cur = "";
		piped = nextPiped;
	};
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === "\\") {
			cur += ch + (raw[++i] ?? "");
		} else if (ch === "|") {
			// `||` is a sequence operator, a single `|` is a pipe.
			const isOr = raw[i + 1] === "|";
			if (isOr) i++;
			push(!isOr);
		} else if (ch === ";" || ch === "&" || ch === "\n") {
			if (ch === "&" && raw[i + 1] === "&") i++;
			push(false);
		} else {
			cur += ch;
		}
	}
	push(false);
	return out;
}

/** Skip wrappers (env/command/nice/time/nohup/exec) and VAR=x, basename the command word, drop git global options. */
function commandWords(tokens: string[]): string[] {
	const base = (t: string) => t.slice(t.lastIndexOf("/") + 1);
	let i = 0;
	for (;;) {
		const t = tokens[i];
		if (t === undefined) break;
		const w = base(t);
		if (/^[A-Za-z_]\w*=/.test(t) || w === "nohup") i++;
		else if (w === "command" || w === "time" || w === "exec") {
			i++;
			while (tokens[i]?.startsWith("-")) i += w === "exec" && tokens[i] === "-a" ? 2 : 1;
		} else if (w === "env") {
			i++;
			while (tokens[i]?.startsWith("-")) {
				const f = tokens[i];
				if (f === "-S" || f === "--split-string") {
					// Re-split the embedded command line and keep classifying it.
					tokens = [...tokenize(tokens[i + 1] ?? "").tokens, ...tokens.slice(i + 2)];
					i = 0;
					break;
				}
				i += ["-u", "-C", "--unset", "--chdir"].includes(f) ? 2 : 1;
			}
		} else if (w === "nice") {
			i++;
			if (tokens[i] === "-n") i += 2;
			else if (/^-\d+$|^--adjustment=/.test(tokens[i] ?? "")) i++;
		} else break;
	}
	const words = tokens.slice(i);
	if (words[0]) words[0] = base(words[0]);
	if (words[0] === "git") {
		let j = 1;
		while (j < words.length && words[j].startsWith("-")) {
			j += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(words[j]) ? 2 : 1;
		}
		return ["git", ...words.slice(j)];
	}
	return words;
}

function segmentReason(words: string[]): string | undefined {
	const [cmd, a, b] = words;
	if (!cmd) return undefined;
	const rest = words.slice(1);
	if (DELETERS.has(cmd)) return `deletes files (${cmd})`;
	if (ELEVATORS.has(cmd)) return `runs with elevated privileges (${cmd})`;
	if (SIMPLE.has(cmd)) return `changes the system (${cmd})`;
	if (cmd === "mkfs" || cmd.startsWith("mkfs.")) return `formats a disk (${cmd})`;
	if (cmd === "gio" && a === "trash") return "deletes files (gio trash)";
	if (cmd === "chmod" && rest.some((t) => /^-\w*R/.test(t) || t === "--recursive")) return "recursive chmod";
	if (cmd === "systemctl" && !rest.includes("--user")) return "changes system services (systemctl)";
	if (cmd === "nix" && a === "profile" && (b === "install" || b === "remove")) return `nix profile ${b}`;
	const pipArgs = cmd === "uv" && a === "pip" ? words.slice(2) : cmd === "pip" || cmd === "pip3" ? rest : undefined;
	if (pipArgs && (pipArgs[0] === "install" || pipArgs[0] === "uninstall")) return `pip ${pipArgs[0]}`;
	if (["npm", "pnpm", "yarn"].includes(cmd) && ["i", "install", "add"].includes(a ?? "") && rest.includes("-g"))
		return `global ${cmd} install`;
	if (cmd === "cargo" && a === "install") return "cargo install";
	if (cmd === "flatpak" && (a === "install" || a === "uninstall")) return `flatpak ${a}`;
	if (cmd === "git" && a === "push") return "git push";
	if (cmd === "git" && a === "clean") return "git clean";
	if (cmd === "git" && a === "reset" && rest.includes("--hard")) return "git reset --hard";
	if (cmd === "find" && rest.includes("-delete")) return "deletes files (find -delete)";
	return undefined;
}

/** Short human reason when the tool call is risky enough to ask first, else undefined. */
export function riskReason(toolName: string, input: unknown): string | undefined {
	if (toolName !== "bash") return undefined;
	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	for (const seg of segments(command)) {
		const words = commandWords(tokenize(seg.text).tokens);
		if (seg.piped && words[0] && SHELLS.has(words[0])) return `pipes into a shell (${words[0]})`;
		const reason = segmentReason(words);
		if (reason) return reason;
	}
	return undefined;
}

export default function humminConfirm(pi: ExtensionAPI): void {
	if (process.env.HUMMIN_CONFIRM !== "1") return;
	pi.on("tool_call", async (event, ctx) => {
		const reason = riskReason(event.toolName, event.input);
		if (!reason) return undefined;
		const command = (event.input as { command?: string }).command ?? "";
		if (await ctx.ui.confirm("Allow this step?", `${reason}\n\n${command}`)) return undefined;
		return { block: true, reason: `Renzo denied: ${reason}` };
	});
}
