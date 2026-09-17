import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { loadExtensionsCached } from "../src/core/extensions/loader.ts";
import {
	createTransformCache,
	ENV_TRANSFORM_CACHE,
	gcTransformCache,
	type TransformFallback,
	type TransformOptions,
	transformCacheDir,
} from "../src/core/extensions/transform-cache.ts";

function makeOpts(overrides: Partial<TransformOptions> = {}): TransformOptions {
	return {
		source: "export default function (api: unknown): unknown { return api; }\n",
		filename: join(tmpdir(), "fake-extension.ts"),
		ts: true,
		interopDefault: true,
		async: false,
		jsx: false,
		...overrides,
	};
}

/** Deterministic pseudo-transform so cached output is comparable across runs. */
function fakeFallback(): TransformFallback {
	return (opts) => ({ code: `// transformed(${opts.source.length})\n${opts.source}` });
}

describe("jiti transform cache", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "jiti-transform-cache-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("misses on first call, writes cache, and serves a byte-identical hit without invoking the fallback", () => {
		const fallback = vi.fn(fakeFallback());
		const opts = makeOpts();

		const cold = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		const coldResult = cold.transform(opts);
		expect(cold.stats.misses).toBe(1);
		expect(cold.stats.hits).toBe(0);
		expect(fallback).toHaveBeenCalledTimes(1);

		const warm = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		const warmResult = warm.transform(opts);
		expect(warm.stats.hits).toBe(1);
		expect(warm.stats.misses).toBe(0);
		expect(fallback).toHaveBeenCalledTimes(1); // fallback spy not called again
		expect(warmResult.code).toBe(coldResult.code);

		// value + sidecar files exist under <agentDir>/cache/jiti/
		const dir = transformCacheDir(agentDir);
		expect(existsSync(dir)).toBe(true);
		expect(readdirSync(dir).filter((n) => n.endsWith(".js")).length).toBe(1);
		expect(readdirSync(dir).filter((n) => n.endsWith(".json")).length).toBe(1);
	});

	it("invalidates when the source is edited", () => {
		const fallback = vi.fn(fakeFallback());
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		cache.transform(makeOpts());
		cache.transform(makeOpts({ source: "export default 2;\n" }));
		expect(fallback).toHaveBeenCalledTimes(2);
		expect(cache.stats.misses).toBe(2);
		expect(cache.stats.hits).toBe(0);
	});

	it("invalidates when the jiti/toolchain version changes", () => {
		const fallback = vi.fn(fakeFallback());
		const opts = makeOpts();
		createTransformCache(agentDir, { toolchainVersion: "jiti@2.7.0", defaultTransform: fallback }).transform(opts);
		const afterBump = createTransformCache(agentDir, { toolchainVersion: "jiti@2.8.0", defaultTransform: fallback });
		afterBump.transform(opts);
		expect(fallback).toHaveBeenCalledTimes(2);
		expect(afterBump.stats.misses).toBe(1);
	});

	it("invalidates when transform options change", () => {
		const fallback = vi.fn(fakeFallback());
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		cache.transform(makeOpts({ ts: true }));
		cache.transform(makeOpts({ ts: false }));
		expect(fallback).toHaveBeenCalledTimes(2);
		expect(cache.stats.misses).toBe(2);
	});

	it("does not key on the absolute filename", () => {
		const fallback = vi.fn(fakeFallback());
		createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback }).transform(
			makeOpts({ filename: "/somewhere/a.ts" }),
		);
		const warm = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		warm.transform(makeOpts({ filename: "/elsewhere/b.ts" }));
		expect(warm.stats.hits).toBe(1);
	});

	it("is fully disabled by HUMMIN_JITI_CACHE=0 (no reads, no writes)", () => {
		vi.stubEnv(ENV_TRANSFORM_CACHE, "0");
		const fallback = vi.fn(fakeFallback());
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		const opts = makeOpts();
		cache.transform(opts);
		cache.transform(opts);
		expect(fallback).toHaveBeenCalledTimes(2);
		expect(existsSync(transformCacheDir(agentDir))).toBe(false);
	});

	it("ignores a corrupt or mismatched sidecar and falls back", () => {
		const fallback = vi.fn(fakeFallback());
		const opts = makeOpts();
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		cache.transform(opts);
		const dir = transformCacheDir(agentDir);
		const jsName = readdirSync(dir).find((n) => n.endsWith(".js"));
		if (!jsName) throw new Error("cache entry missing");
		const key = jsName.slice(0, -3);

		// Corrupt sidecar: read must fail closed and retransform.
		writeFileSync(join(dir, `${key}.json`), "{not json");
		const warm = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		warm.transform(opts);
		expect(warm.stats.misses).toBe(1);

		// Sidecar whose key does not match the recomputed one: fail closed too.
		const fresh = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		fresh.transform(makeOpts({ source: "export default 3;\n" }));
		const stale = { key: "deadbeef", sourceHash: "deadbeef", jitiVersion: "test-v1", createdAt: Date.now() };
		writeFileSync(join(dir, `${key}.json`), JSON.stringify(stale));
		const verify = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		verify.transform(opts);
		expect(verify.stats.misses).toBe(1);
	});

	it("never caches transform errors", () => {
		const failingFallback: TransformFallback = () => ({ code: "", error: new Error("syntax") });
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: failingFallback });
		cache.transform(makeOpts());
		expect(existsSync(transformCacheDir(agentDir))).toBe(false);
	});

	it("does not cache when sourceMaps are enabled (output embeds absolute paths)", () => {
		const fallback = vi.fn(fakeFallback());
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		cache.transform(makeOpts({ babel: { sourceMaps: "inline", sourceFileName: "/x/y.ts" } }));
		expect(existsSync(transformCacheDir(agentDir))).toBe(false);
	});

	it("gc removes entries by age, entry count, and total size", async () => {
		const fallback = fakeFallback();
		const cache = createTransformCache(agentDir, { toolchainVersion: "test-v1", defaultTransform: fallback });
		cache.transform(makeOpts({ source: "export default 1;\n" }));
		cache.transform(makeOpts({ source: "export default 2;\n" }));
		cache.transform(makeOpts({ source: "export default 3;\n" }));
		const dir = transformCacheDir(agentDir);
		expect(readdirSync(dir).filter((n) => n.endsWith(".js")).length).toBe(3);

		// Age sweep: backdate one sidecar past the cutoff.
		const first = readdirSync(dir).find((n) => n.endsWith(".json"));
		if (!first) throw new Error("sidecar missing");
		const sidecar = JSON.parse(readFileSync(join(dir, first), "utf8")) as { createdAt: number };
		sidecar.createdAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
		writeFileSync(join(dir, first), JSON.stringify(sidecar));
		const byAge = await gcTransformCache(agentDir, { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
		expect(byAge.removed).toBe(1);
		expect(readdirSync(dir).filter((n) => n.endsWith(".js")).length).toBe(2);

		// Entry cap.
		const byCount = await gcTransformCache(agentDir, { maxEntries: 1 });
		expect(byCount.removed).toBe(1);
		expect(readdirSync(dir).filter((n) => n.endsWith(".js")).length).toBe(1);

		// Size cap smaller than the remaining entry.
		const bySize = await gcTransformCache(agentDir, { maxBytes: 1 });
		expect(bySize.removed).toBe(1);
		expect(existsSync(dir)).toBe(true);
		expect(readdirSync(dir).filter((n) => n.endsWith(".js")).length).toBe(0);
	});
});

describe("extension loader integration", () => {
	let parentAgentDir: string | undefined;
	let agentDir: string;
	let extDir: string;

	beforeEach(() => {
		parentAgentDir = process.env[ENV_AGENT_DIR];
		agentDir = mkdtempSync(join(tmpdir(), "jiti-loader-agent-"));
		extDir = mkdtempSync(join(tmpdir(), "jiti-loader-ext-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// Deterministic transform output: the fake extension compiles fine and
		// the cache dir must appear under the isolated agent dir.
		mkdirSync(join(agentDir, "cache"), { recursive: true });
	});

	afterEach(() => {
		if (parentAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = parentAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(extDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("stores transforms under <agentDir>/cache/jiti and still loads the extension", async () => {
		const extPath = join(extDir, "noop.ts");
		// Unique source per run: jiti's own fs cache (tmp dir, outside our control)
		// would otherwise serve a hit and skip our transform hook entirely.
		const salt = `${process.pid}-${Date.now()}`;
		writeFileSync(extPath, `// ${salt}\nexport default function noop(_api: unknown): void {}\n`);

		const first = await loadExtensionsCached([extPath], extDir);
		expect(first.errors).toEqual([]);
		expect(first.extensions.length).toBe(1);
		const dir = transformCacheDir(agentDir);
		expect(existsSync(dir)).toBe(true);
		expect(readdirSync(dir).filter((n) => n.endsWith(".js")).length).toBeGreaterThan(0);

		// Second load serves from cache and still works.
		const second = await loadExtensionsCached([extPath], extDir);
		expect(second.errors).toEqual([]);
		expect(second.extensions.length).toBe(1);
	});

	it("HUMMIN_JITI_CACHE=0 keeps the loader working without creating the cache dir", async () => {
		vi.stubEnv(ENV_TRANSFORM_CACHE, "0");
		const extPath = join(extDir, "noop.ts");
		writeFileSync(extPath, `// unique-${Date.now()}\nexport default function noop2(_api: unknown): void {}\n`);
		const result = await loadExtensionsCached([extPath], extDir);
		expect(result.errors).toEqual([]);
		expect(existsSync(transformCacheDir(agentDir))).toBe(false);
	});
});
