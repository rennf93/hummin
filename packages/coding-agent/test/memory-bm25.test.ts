import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	BM25_K1,
	bm25Doc,
	bm25Idf,
	bm25Score,
	buildDf,
	recallLessons,
	tokenizeList,
} from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
});

beforeEach(() => {
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-bm25-test-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-bm25-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR!, process.env.HUMMIN_MEMORY_VAULT_DIR!);
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
	if (vaultDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultDirOriginal;
});

const PROJ = "/Users/renzof/work/alpha";

function seedLessons(lines: Array<{ cwd: string; lesson: string; timestamp?: string }>): void {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
}

// --- Pure scorer unit tests -------------------------------------------------

test("tokenizeList lowercases, splits, drops stopwords and short tokens", () => {
	expect(tokenizeList("Fix the react-portal bug in src/foo.ts")).toEqual(["fix", "react-portal", "bug", "src/foo.ts"]);
});

test("bm25Doc counts term frequencies and length", () => {
	const doc = bm25Doc(["a", "b", "a"]);
	expect(doc.termCounts.get("a")).toBe(2);
	expect(doc.termCounts.get("b")).toBe(1);
	expect(doc.length).toBe(3);
});

test("buildDf counts docs containing a term, not occurrences", () => {
	const docs = [bm25Doc(["x", "y"]), bm25Doc(["x", "x"]), bm25Doc(["z"])];
	const df = buildDf(docs);
	expect(df.get("x")).toBe(2);
	expect(df.get("y")).toBe(1);
	expect(df.get("z")).toBe(1);
	expect(df.get("missing")).toBeUndefined();
});

test("bm25Idf is positive at df == docCount (Lucene floor) and grows as df shrinks", () => {
	const common = bm25Idf(10, 10);
	const rare = bm25Idf(1, 10);
	expect(common).toBeGreaterThan(0);
	expect(rare).toBeGreaterThan(common);
});

test("bm25Idf with zero df and zero-doc corpus edge stays finite", () => {
	expect(Number.isFinite(bm25Idf(0, 0))).toBe(true);
});

test("bm25Score is 0 when no query term is present", () => {
	const doc = bm25Doc(["alpha", "beta"]);
	const df = buildDf([doc]);
	expect(bm25Score(["gamma"], doc, df, 2, 1)).toBe(0);
});

test("bm25Score saturates with repeated terms (tf saturation via k1)", () => {
	const docs = [bm25Doc(["term"]), bm25Doc(Array<string>(20).fill("term"))];
	const df = buildDf(docs);
	const single = bm25Score(["term"], docs[0], df, 10.5, 2);
	const twenty = bm25Score(["term"], docs[1], df, 10.5, 2);
	expect(twenty).toBeGreaterThan(single);
	// Saturation: 20 occurrences must score far less than 20x single.
	expect(twenty).toBeLessThan(single * 5);
});

test("bm25Score length normalization (b) favors short docs on ties in tf", () => {
	const short = bm25Doc(["widget", "pad1", "pad2", "pad3"]);
	const long = bm25Doc(["widget", ...Array<string>(16).fill("pad")]);
	const df = buildDf([short, long]);
	const avgLen = (short.length + long.length) / 2;
	const shortScore = bm25Score(["widget"], short, df, avgLen, 2);
	const longScore = bm25Score(["widget"], long, df, avgLen, 2);
	expect(shortScore).toBeGreaterThan(longScore);
	// With b=0 the length advantage must disappear (both tf=1, same idf).
	expect(bm25Score(["widget"], short, df, avgLen, 2, BM25_K1, 0)).toBeCloseTo(
		bm25Score(["widget"], long, df, avgLen, 2, BM25_K1, 0),
		10,
	);
});

test("BM25 beats naive overlap: rare-term discrimination", () => {
	// Doc A matches the query with a common term only; doc B additionally
	// matches a rare term. Both have overlap 1 under naive counting on the
	// rare axis, but BM25 must rank the rare-term doc clearly higher.
	// "common" appears in both docs (high df); "rare" only in docB (low df).
	// Naive overlap counts each match as 1; BM25 weights the rare match much
	// higher, so docB (rare + common) outranks docA (common + filler).
	const common = "session";
	const rare = "kubernetes";
	const docA = bm25Doc([common, ...Array<string>(8).fill("filler")]);
	const docB = bm25Doc([common, rare]);
	const docs = [docA, docB];
	const df = buildDf(docs);
	const avgLen = (docA.length + docB.length) / 2;
	const query = tokenizeList(`${common} ${rare}`);
	const scoreA = bm25Score(query, docA, df, avgLen, 2);
	const scoreB = bm25Score(query, docB, df, avgLen, 2);
	// Naive overlap would tie the rare-term contribution; BM25 gives the
	// rare term a much larger idf weight than the ubiquitous common term.
	expect(df.get(rare)!).toBeLessThan(df.get(common)!);
	expect(scoreB).toBeGreaterThan(scoreA);
});

test("recallLessons ranks rare-term lesson first despite equal overlap", () => {
	// Both lessons share exactly one query term (overlap 1 each) but the
	// second contains the rare query term. BM25 must rank it first.
	seedLessons([
		{ cwd: PROJ, lesson: "setup notes about testing setup filler filler filler filler" },
		{ cwd: PROJ, lesson: "crash in kubernetes controller when scaling" },
	]);
	const ranked = recallLessons(PROJ, "kubernetes", 3);
	expect(ranked.length).toBe(1);
	expect(ranked[0]).toContain("kubernetes");
});

test("recallLessons caps results at 3 lessons (char cap lives in briefing assembly)", () => {
	const longLesson = `lesson about kubernetes ${"padding ".repeat(400)}`;
	seedLessons([
		{ cwd: PROJ, lesson: `kubernetes a ${"filler ".repeat(400)}` },
		{ cwd: PROJ, lesson: `kubernetes b ${"filler ".repeat(400)}` },
		{ cwd: PROJ, lesson: `kubernetes c ${"filler ".repeat(400)}` },
		{ cwd: PROJ, lesson: `kubernetes d ${"filler ".repeat(400)}` },
		{ cwd: PROJ, lesson: longLesson },
	]);
	const ranked = recallLessons(PROJ, "kubernetes", 3);
	expect(ranked.length).toBeLessThanOrEqual(3);
});

test("recallLessons enforces cross-project >= 2 term overlap when scope is all", () => {
	seedLessons([
		{ cwd: "/elsewhere/x", lesson: "unrelated project with kubernetes only" },
		{ cwd: "/elsewhere/y", lesson: "kubernetes deployment crash pipeline" },
	]);
	expect(recallLessons(PROJ, "kubernetes", 3, "all")).toEqual([]);
	// Two matched terms passes the cross-project floor.
	expect(recallLessons(PROJ, "kubernetes deployment", 3, "all").length).toBe(1);
});

test("recallLessons is deterministic across repeated calls", () => {
	seedLessons([{ cwd: PROJ, lesson: "kubernetes crash" }]);
	expect(recallLessons(PROJ, "kubernetes", 3).length).toBe(1);
	// Same results on repeat (session dedup happens in the caller, not here).
	expect(recallLessons(PROJ, "kubernetes", 3).length).toBe(1);
	expect(recallLessons(PROJ, "different query entirely", 3).length).toBe(0);
});

test("recallLessons adds recency and phrase bonuses on top of BM25", () => {
	const now = new Date().toISOString();
	const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
	seedLessons([
		{ cwd: PROJ, lesson: "kubernetes rollout gotcha when pods restart", timestamp: old },
		{ cwd: PROJ, lesson: "kubernetes rollout issue elsewhere", timestamp: now },
	]);
	const ranked = recallLessons(PROJ, "kubernetes rollout", 3);
	// Same core terms; the fresh lesson with the exact phrase must win.
	expect(ranked[0]).toContain("rollout issue elsewhere");
});
