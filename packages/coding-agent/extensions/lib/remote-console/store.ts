/**
 * lib/remote-console/store: persistence for the remote console's server-side
 * state. The console keeps appearance preferences browser-side (localStorage);
 * the store owns the CORS allowlist of console origins, the origins allowed to
 * fetch this host cross-origin for fleet-wide aggregation. The file lives at
 * `<agentDir>/remote-console/console-origins.json`, is written atomically
 * (tmp + rename, mode 0600), and its contents are never logged.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The origins allowed to fetch this host cross-origin. */
export interface ConsoleOriginStore {
	list(): readonly string[];
	/** Validate, normalize, append, and persist one origin. Throws on an
	 * invalid origin; returns the updated list. */
	add(origin: string): readonly string[];
}

/** A normalized http(s) origin (scheme://host[:port], no path, no trailing slash). */
export function isValidConsoleOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (!url.hostname) return false;
		if (url.pathname !== "/" && url.pathname !== "") return false;
		if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return false;
		return url.origin === value || `${url.origin}/` === value;
	} catch {
		return false;
	}
}

/** Normalize an already-validated origin to `url.origin` form. */
function normalizeOrigin(value: string): string {
	return new URL(value).origin;
}

function readOrigins(path: string): string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { origins?: unknown }).origins)) {
			return [];
		}
		// Settings-file trust boundary: keep only well-formed origins.
		return (parsed as { origins: unknown[] }).origins.filter(
			(origin): origin is string => typeof origin === "string" && isValidConsoleOrigin(origin),
		);
	} catch {
		// Missing or unreadable file: empty allowlist, writes still work.
		return [];
	}
}

/** Atomic write: tmp file in the target directory plus rename, 0600. Never
 * creates world-readable state; a failure surfaces to the caller. */
function atomicWrite(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, contents, { mode: 0o600 });
	renameSync(tmp, path);
}

function writeOrigins(path: string, origins: readonly string[]): void {
	atomicWrite(path, `${JSON.stringify({ origins: [...origins] }, null, "\t")}\n`);
}

export function openConsoleOriginStore(path: string): ConsoleOriginStore {
	let origins = readOrigins(path);
	return {
		list: () => origins,
		add: (origin: string) => {
			if (!isValidConsoleOrigin(origin)) throw new Error("Origin must be an http(s) origin like https://host:port");
			const normalized = normalizeOrigin(origin);
			if (origins.includes(normalized)) return origins;
			const updated = [...origins, normalized];
			writeOrigins(path, updated);
			origins = updated;
			return origins;
		},
	};
}

/** True when a directory holds a servable console build (an index.html). */
export function isConsoleDistDir(dir: string): boolean {
	try {
		return statSync(`${dir}/index.html`).isFile();
	} catch {
		return false;
	}
}
