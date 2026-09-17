/**
 * Content-addressed cache for jiti transforms of runtime-TS extensions.
 *
 * Every launch re-transforms identical extension sources through jiti/babel.
 * This module caches the transformed source under `<agentDir>/cache/jiti/`,
 * keyed by SHA-256 over (toolchain version, transform options, source bytes).
 * Entries are validated on read against the recomputed source hash, written
 * atomically (temp file + rename), and pruned by a size/age sweep.
 *
 * Trust: extensions are user-owned and executed with user privileges; the
 * cache lives beside them with 0700 perms, so it adds no new trust boundary.
 * The cache is a pure function of (source, toolchain): the key recomputed
 * from the live source must match the entry's key before it is served.
 *
 * Set HUMMIN_JITI_CACHE=0 to disable (read and write).
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TransformOptions, TransformResult } from "jiti";

export const ENV_TRANSFORM_CACHE = "HUMMIN_JITI_CACHE";

export type { TransformOptions, TransformResult } from "jiti";

export interface TransformCacheStats {
	hits: number;
	misses: number;
	/** Total time spent in the fallback (babel) transform on misses. */
	transformMs: number;
}

/** Fallback transform, normally jiti's own default babel transform. */
export type TransformFallback = (opts: TransformOptions) => TransformResult;

export interface CachedTransformer {
	/** Drop-in replacement for jiti's `transform` option. */
	transform(opts: TransformOptions): TransformResult;
	readonly stats: TransformCacheStats;
}

interface CacheSidecar {
	key: string;
	sourceHash: string;
	jitiVersion: string;
	createdAt: number;
}

export interface GcOptions {
	maxBytes?: number;
	maxEntries?: number;
	maxAgeMs?: number;
}

export interface GcResult {
	removed: number;
	bytesRemoved: number;
}

const GC_DEFAULTS: Required<GcOptions> = {
	maxBytes: 20 * 1024 * 1024,
	maxEntries: 200,
	maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};

export function isTransformCacheDisabled(): boolean {
	return process.env[ENV_TRANSFORM_CACHE] === "0";
}

export function transformCacheDir(agentDir: string): string {
	return join(agentDir, "cache", "jiti");
}

/** jiti + bundled babel version string, so toolchain bumps invalidate the cache. */
function toolchainVersion(): string {
	// In compiled binaries packages cannot be required from disk; fall back to a
	// coarse stable string so cache creation never throws there.
	try {
		const req = createRequire(import.meta.url);
		const jitiVersion = req("jiti/package.json").version as string;
		let babelVersion = "bundled";
		try {
			babelVersion = req("@babel/core/package.json").version as string;
		} catch {
			// jiti bundles babel; the jiti version is the meaningful part then.
		}
		return `jiti@${jitiVersion}+babel@${babelVersion}`;
	} catch {
		return "jiti@bundled";
	}
}

/** JSON stringification with recursively sorted keys, so option objects key stably. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function sha256(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute the cache key for a transform call. The filename is excluded: with
 * sourceMaps disabled (the loader's default) the output does not embed it, and
 * excluding it keeps entries valid across directory moves. Calls with
 * sourceMaps enabled are never cached (output embeds absolute paths).
 */
function computeKey(opts: TransformOptions, version: string): { key: string; sourceHash: string } {
	const sourceHash = sha256(opts.source);
	const keyable: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(opts)) {
		if (k === "source" || k === "filename" || k === "babel") continue;
		keyable[k] = v;
	}
	const babelKeyable: Record<string, unknown> = {};
	if (opts.babel) {
		for (const [k, v] of Object.entries(opts.babel)) {
			if (k === "sourceFileName") continue;
			babelKeyable[k] = v;
		}
	}
	const key = sha256([version, stableStringify(keyable), stableStringify(babelKeyable), sourceHash].join("\0"));
	return { key, sourceHash };
}

function writeAtomic(filePath: string, data: string): void {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, data, { mode: 0o600 });
	renameSync(tmp, filePath);
}

function readCached(cachePath: string, sidecarPath: string, key: string, sourceHash: string): string | null {
	try {
		if (!existsSync(cachePath) || !existsSync(sidecarPath)) return null;
		const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as CacheSidecar;
		if (sidecar.key !== key || sidecar.sourceHash !== sourceHash) return null;
		return readFileSync(cachePath, "utf8");
	} catch {
		return null;
	}
}

function storeCached(dir: string, key: string, sourceHash: string, version: string, code: string): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const sidecar: CacheSidecar = { key, sourceHash, jitiVersion: version, createdAt: Date.now() };
		writeAtomic(join(dir, `${key}.js`), code);
		writeAtomic(join(dir, `${key}.json`), JSON.stringify(sidecar));
	} catch {
		// cache is best-effort
	}
}

/**
 * Create a caching transform suitable for jiti's `transform` option. On a miss
 * the default jiti transform (its bundled babel module, the exact function jiti
 * itself uses when no `transform` option is set) is invoked unchanged, so the
 * miss path is byte-identical to un-cached behavior.
 *
 * `createBaseJiti` is a last-resort fallback for environments where the babel
 * module cannot be required from disk (compiled binaries): it lazily builds a
 * plain jiti instance (no transform override) and uses its instance-level
 * transform. It is never called on the normal path.
 */
export function createTransformCache(
	agentDir: string,
	options: {
		toolchainVersion?: string;
		/** Test seam: replaces the real jiti babel module lookup. */
		defaultTransform?: TransformFallback;
		jitiOptions?: Record<string, unknown>;
		createBaseJiti?: (opts: Record<string, unknown>) => { transform: (opts: TransformOptions) => string };
	} = {},
): CachedTransformer {
	const dir = transformCacheDir(agentDir);
	const version = options.toolchainVersion ?? toolchainVersion();
	const stats: TransformCacheStats = { hits: 0, misses: 0, transformMs: 0 };
	let baseJiti: { transform: (opts: TransformOptions) => string } | undefined;

	const fallbackTransform = (opts: TransformOptions): TransformResult => {
		if (options.defaultTransform) return options.defaultTransform(opts);
		try {
			const req = createRequire(import.meta.url);
			const babelTransform = req("jiti/dist/babel.cjs") as (o: TransformOptions) => TransformResult;
			return babelTransform(opts);
		} catch (error) {
			if (!options.createBaseJiti) throw error;
			if (!baseJiti) baseJiti = options.createBaseJiti(options.jitiOptions ?? {});
			// jiti's instance-level .transform() returns the code string.
			return { code: baseJiti.transform(opts) };
		}
	};

	return {
		stats,
		transform(opts: TransformOptions): TransformResult {
			// No filename (ephemeral sources) or inline source maps (absolute
			// paths embedded in output) are not safely cacheable.
			const inlineMaps = opts.babel?.sourceMaps !== undefined && opts.babel.sourceMaps !== false;
			if (isTransformCacheDisabled() || !opts.filename || inlineMaps) {
				return fallbackTransform(opts);
			}
			const { key, sourceHash } = computeKey(opts, version);
			const cached = readCached(join(dir, `${key}.js`), join(dir, `${key}.json`), key, sourceHash);
			if (cached !== null) {
				stats.hits++;
				return { code: cached };
			}
			stats.misses++;
			const start = performance.now();
			const result = fallbackTransform(opts);
			stats.transformMs += performance.now() - start;
			// jiti embeds this marker in code that failed to transform; never cache errors.
			if (!result.error && !result.code.includes("__JITI_ERROR__")) {
				storeCached(dir, key, sourceHash, version, result.code);
			}
			return result;
		},
	};
}

/**
 * Sweep the cache directory: drop entries older than maxAgeMs, then enforce
 * entry-count and total-size caps (oldest first). Missing sidecars make an
 * entry removable only when caps are enforced, so a partial write cannot
 * invalidate its sibling mid-run.
 */
export async function gcTransformCache(agentDir: string, options?: GcOptions): Promise<GcResult> {
	const limits = { ...GC_DEFAULTS, ...options };
	const dir = transformCacheDir(agentDir);
	const result: GcResult = { removed: 0, bytesRemoved: 0 };
	let entries: Array<{ key: string; createdAt: number; bytes: number }> = [];
	try {
		if (!existsSync(dir)) return result;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".js")) continue;
			const key = name.slice(0, -3);
			const jsPath = join(dir, name);
			let bytes = 0;
			let createdAt = 0;
			try {
				bytes = statSync(jsPath).size;
				const sidecar = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as CacheSidecar;
				createdAt = typeof sidecar.createdAt === "number" ? sidecar.createdAt : 0;
			} catch {
				createdAt = 0;
			}
			entries.push({ key, createdAt, bytes });
		}
	} catch {
		return result;
	}

	const now = Date.now();
	const cutoff = now - limits.maxAgeMs;
	const remove = (entry: { key: string; bytes: number }): void => {
		try {
			unlinkSync(join(dir, `${entry.key}.js`));
			unlinkSync(join(dir, `${entry.key}.json`));
		} catch {
			// best-effort
		}
		result.removed++;
		result.bytesRemoved += entry.bytes;
	};

	for (const entry of entries) {
		if (entry.createdAt !== 0 && entry.createdAt < cutoff) remove(entry);
	}
	entries = entries.filter((e) => existsSync(join(dir, `${e.key}.js`)));
	entries.sort((a, b) => a.createdAt - b.createdAt);
	let totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
	while (entries.length > limits.maxEntries || totalBytes > limits.maxBytes) {
		const entry = entries.shift();
		if (!entry) break;
		totalBytes -= entry.bytes;
		remove(entry);
	}
	return result;
}

/**
 * Schedule the GC sweep off the critical path (after first paint). The timer
 * is unref'd so it never keeps the process alive.
 */
export function scheduleTransformCacheGc(agentDir: string, options?: GcOptions): void {
	const timer = setTimeout(() => {
		void gcTransformCache(agentDir, options).catch(() => {});
	}, 5_000);
	timer.unref();
}
