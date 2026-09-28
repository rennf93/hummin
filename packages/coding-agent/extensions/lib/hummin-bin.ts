/**
 * How to spawn another hummin CLI process from extension code.
 *
 * Children (task, cron, query expansion, auto-fold) used to spawn the bare
 * name `hummin` and rely on PATH, which fails silently in checkouts without
 * `npm link`. The reliable replay of THIS process is `process.execPath` plus
 * `process.argv[1]` (the CLI entry that is already running), so that is the
 * default. HUMMIN_BIN overrides the binary name/path outright (value is split
 * on spaces for argv[0] plus optional leading args), and when argv[1] is not a
 * usable file the helper falls back to the PATH name as before.
 */
import { existsSync, statSync } from "node:fs";

export interface HumminCommand {
	command: string;
	/** Arguments that must precede the caller's own arguments (CLI script path). */
	prefixArgs: string[];
}

export function humminBinCommand(env: Readonly<Record<string, string | undefined>> = process.env): HumminCommand {
	const override = env.HUMMIN_BIN?.trim();
	if (override) {
		const parts = override.split(/\s+/).filter(Boolean);
		return { command: parts[0]!, prefixArgs: parts.slice(1) };
	}
	const entry = process.argv[1];
	if (
		entry &&
		entry.includes("/") &&
		/\.(js|mjs|cjs|ts)$/.test(entry) &&
		existsSync(entry) &&
		statSync(entry).isFile()
	) {
		return { command: process.execPath, prefixArgs: [entry] };
	}
	return { command: "hummin", prefixArgs: [] };
}

/** argv for a detached/child hummin run: spawn(command, [...prefixArgs, ...args]). */
export function humminArgv(args: readonly string[]): { command: string; args: string[] } {
	const bin = humminBinCommand();
	return { command: bin.command, args: [...bin.prefixArgs, ...args] };
}
