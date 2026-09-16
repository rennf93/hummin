import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionFlag } from "../core/extensions/types.ts";

interface FlagsCache {
	fingerprint: string;
	flags: ExtensionFlag[];
}

/** mtime+size fingerprint of all source files under the agent extensions dir, null if unreadable. */
function fingerprintExtensionsDir(dir: string): string | null {
	if (!existsSync(dir)) return "";
	const entries: string[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
			const stats = statSync(path);
			entries.push(`${relative(dir, path)}:${stats.mtimeMs}:${stats.size}`);
		}
	};
	try {
		walk(dir);
	} catch {
		return null;
	}
	return entries.sort().join("|");
}

/**
 * Cached extension CLI flags from a previous full load, valid only while the
 * extensions directory is unchanged. Lets `--help` skip building the runtime.
 */
export function readExtensionFlagsCache(agentDir: string): ExtensionFlag[] | null {
	const cachePath = join(agentDir, "extension-flags-cache.json");
	try {
		if (!existsSync(cachePath)) return null;
		const cache = JSON.parse(readFileSync(cachePath, "utf8")) as FlagsCache;
		const fingerprint = fingerprintExtensionsDir(join(agentDir, "extensions"));
		if (fingerprint === null || cache.fingerprint !== fingerprint) return null;
		if (!Array.isArray(cache.flags)) return null;
		return cache.flags;
	} catch {
		return null;
	}
}

/** Persist flags after a full extension load. Best-effort; failures are ignored. */
export function writeExtensionFlagsCache(agentDir: string, flags: ExtensionFlag[]): void {
	try {
		const fingerprint = fingerprintExtensionsDir(join(agentDir, "extensions"));
		if (fingerprint === null) return;
		const payload: FlagsCache = { fingerprint, flags };
		writeFileSync(join(agentDir, "extension-flags-cache.json"), JSON.stringify(payload, null, "\t"));
	} catch {
		// cache is best-effort
	}
}
