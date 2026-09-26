import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { expandQueryTerms, parseExpansionKeywords, searchVault } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;
let expandOriginal: string | undefined;
let pathOriginal: string | undefined;

beforeEach(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
	expandOriginal = process.env.HUMMIN_MEMORY_QUERY_EXPAND;
	pathOriginal = process.env.PATH;
	// Expansion on for this suite; each test seeds its own temp dirs so
	// concurrently running files never leak into these calls.
	process.env.HUMMIN_MEMORY_QUERY_EXPAND = "1";
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-expand-memory-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-expand-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR, process.env.HUMMIN_MEMORY_VAULT_DIR);
});

afterEach(() => {
	if (pathOriginal === undefined) delete process.env.PATH;
	else process.env.PATH = pathOriginal;
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
	if (vaultDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultDirOriginal;
	if (expandOriginal === undefined) delete process.env.HUMMIN_MEMORY_QUERY_EXPAND;
	else process.env.HUMMIN_MEMORY_QUERY_EXPAND = expandOriginal;
});

/** Mock `hummin` on PATH: appends its argv to the args file (one line per
 * call marker) and prints a fixed keyword list. */
function installHumminMock(reply = "alpha, beta, gamma-delta"): string {
	const bin = mkdtempSync(join(tmpdir(), "hummin-expand-bin-"));
	createdDirs.push(bin);
	const argsFile = join(bin, "args");
	writeFileSync(
		join(bin, "hummin"),
		`#!/bin/sh\nprintf '%s\\n' "$@" >> ${argsFile}\nprintf 'call\\n' >> ${argsFile}\necho "${reply}"\n`,
	);
	chmodSync(join(bin, "hummin"), 0o755);
	process.env.PATH = `${bin}:${pathOriginal ?? ""}`;
	return argsFile;
}

function mockCallCount(argsFile: string): number {
	if (!existsSync(argsFile)) return 0;
	return readFileSync(argsFile, "utf8")
		.split("\n")
		.filter((line) => line === "call").length;
}

test("parseExpansionKeywords keeps single clean tokens, dedupes, caps at 8", () => {
	expect(parseExpansionKeywords("Alpha, beta\ngamma-delta, --junk, a, alpha-beta alpha")).toEqual([
		"alpha",
		"beta",
		"gamma-delta",
		"alpha-beta",
	]);
	const many = Array.from({ length: 12 }, (_, i) => `kw${i}`).join(", ");
	expect(parseExpansionKeywords(many)).toHaveLength(8);
	expect(parseExpansionKeywords("")).toEqual([]);
});

test("expandQueryTerms returns model keywords and caches per query", async () => {
	const argsFile = installHumminMock();
	const query = "kubernetes rollout strategy";
	expect(await expandQueryTerms(query)).toEqual(["alpha", "beta", "gamma-delta"]);
	expect(await expandQueryTerms(query)).toEqual(["alpha", "beta", "gamma-delta"]);
	// second identical call is served from the process-lifetime cache
	expect(mockCallCount(argsFile)).toBe(1);
});

test("expandQueryTerms fail-opens to [] when the binary is unavailable", async () => {
	process.env.PATH = mkdtempSync(join(tmpdir(), "hummin-expand-empty-"));
	// A fresh query: an earlier test cached an expansion for a different one,
	// and the cache is keyed per query for the process lifetime.
	expect(await expandQueryTerms("quantum lattice simulation")).toEqual([]);
});

test("expandQueryTerms is disabled by HUMMIN_MEMORY_QUERY_EXPAND=0", async () => {
	process.env.HUMMIN_MEMORY_QUERY_EXPAND = "0";
	const argsFile = installHumminMock();
	expect(await expandQueryTerms("kubernetes rollout strategy")).toEqual([]);
	expect(mockCallCount(argsFile)).toBe(0);
});

test("stopword-only and empty queries skip the model call", async () => {
	const argsFile = installHumminMock();
	expect(await expandQueryTerms("the and for")).toEqual([]);
	expect(await expandQueryTerms("   ")).toEqual([]);
	expect(mockCallCount(argsFile)).toBe(0);
});

test("searchVault reaches lessons through the expanded query", async () => {
	installHumminMock("quotas");
	// The lesson shares no vocabulary with the raw query; only the expanded
	// keyword can bridge the paraphrase gap.
	const lesson = "Gotcha: zfs quotas throttle writes once the pool reservation is reached";
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${JSON.stringify({ cwd: "/Users/renzof/work/alpha", lesson })}\n`,
	);
	const result = await searchVault("storage limits pipeline", "/Users/renzof/work/alpha");
	expect(result).toContain("Lessons (1)");
	expect(result).toContain("zfs quotas throttle writes");
});
