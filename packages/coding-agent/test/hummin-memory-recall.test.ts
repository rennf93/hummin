import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	assembleBriefing,
	injectedIdsFromEntries,
	lessonIdOf,
	markLessonsInjected,
	recallLessons,
	searchVault,
	stampLessonLine,
} from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];
let memoryDirOriginal: string | undefined;
let vaultDirOriginal: string | undefined;
let expandOriginal: string | undefined;
let embedOriginal: string | undefined;

beforeAll(() => {
	memoryDirOriginal = process.env.HUMMIN_MEMORY_DIR;
	vaultDirOriginal = process.env.HUMMIN_MEMORY_VAULT_DIR;
	// Query expansion (a model call) stays off in retrieval tests: they pin
	// the plain-lexical ranking behavior.
	expandOriginal = process.env.HUMMIN_MEMORY_QUERY_EXPAND;
	process.env.HUMMIN_MEMORY_QUERY_EXPAND = "0";
	// Embeddings stay off too: a developer-env HUMMIN_MEMORY_EMBED_URL must not
	// turn these lexical-ranking pins into network-dependent tests.
	embedOriginal = process.env.HUMMIN_MEMORY_EMBED;
	process.env.HUMMIN_MEMORY_EMBED = "0";
});

// Isolate each test's memory and vault dirs: the module reads both env vars
// at call time, so other test files that override them concurrently must not
// leak their temp dirs into these calls.
beforeEach(() => {
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-test-"));
	process.env.HUMMIN_MEMORY_VAULT_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-vault-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR, process.env.HUMMIN_MEMORY_VAULT_DIR);
});

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	if (memoryDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = memoryDirOriginal;
	if (vaultDirOriginal === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = vaultDirOriginal;
	if (expandOriginal === undefined) delete process.env.HUMMIN_MEMORY_QUERY_EXPAND;
	else process.env.HUMMIN_MEMORY_QUERY_EXPAND = expandOriginal;
	if (embedOriginal === undefined) delete process.env.HUMMIN_MEMORY_EMBED;
	else process.env.HUMMIN_MEMORY_EMBED = embedOriginal;
});

const PROJ = "/Users/renzof/work/alpha";
const UNRELATED = "/Users/renzof/elsewhere";

function seedLessons(lines: Array<{ cwd: string; lesson: string }>): void {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
}

test("project scope requires keyword overlap and excludes other projects", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
		{ cwd: PROJ, lesson: "Gotcha: restart the hummin container to clear orphaned generations" },
		{ cwd: UNRELATED, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" },
	]);
	// default scope: project only, overlap required
	const lessons = recallLessons(PROJ, "docker compose force-recreate");
	expect(lessons).toEqual(["Gotcha: docker compose needs --force-recreate after mem_limit changes to apply"]);
	// sibling project lesson excluded even with strong overlap
	expect(lessons.some((l) => l.includes("orphaned"))).toBe(false);
});

test("all scope includes cross-project lessons with at least two keyword overlaps", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
		{ cwd: UNRELATED, lesson: "Gotcha: zfs dataset quotas silently cap docker volume writes on this NAS" },
		{ cwd: UNRELATED, lesson: "Gotcha: always warm the cache before benchmarking anything at all" },
	]);
	const lessons = recallLessons(PROJ, "zfs quota docker volume problem", 5, "all");
	// project lesson included (overlap), cross-project zfs lesson passes the floor,
	// the warm-cache lesson does not
	expect(lessons).toHaveLength(2);
	expect(lessons.some((l) => l.includes("zfs"))).toBe(true);
	expect(lessons.some((l) => l.includes("warm"))).toBe(false);
});

test("project lessons rank above cross-project ones, recency breaks ties", () => {
	seedLessons([
		{ cwd: UNRELATED, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" },
		{ cwd: PROJ, lesson: "Gotcha: docker dataset volume writes stall when quotas are hit" },
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
	]);
	const lessons = recallLessons(PROJ, "docker compose quotas", 5, "all");
	// BM25 (slice 9): the corpus-rare term "quotas" outranks common-term matches,
	// so the quotas lesson ranks first despite matching one fewer term overall.
	// Between the two force-recreate lessons, BM25 length normalization gives the
	// shorter document the edge (same matched terms, fewer total tokens).
	expect(lessons[0]).toBe("Gotcha: docker dataset volume writes stall when quotas are hit");
	expect(lessons[1]).toBe("Gotcha: docker compose needs --force-recreate after mem_limit changes");
	expect(lessons[2]).toBe("Gotcha: docker compose needs --force-recreate after mem_limit changes to apply");
});

test("empty query returns nothing", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes to apply" },
	]);
	expect(recallLessons(PROJ, "the the the")).toEqual([]);
	expect(recallLessons(PROJ, "")).toEqual([]);
});

test("three-character terms match (zfs, api, git)", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: zfs dataset quotas silently cap docker volume writes on this NAS" },
		{ cwd: PROJ, lesson: "Gotcha: the api gateway strips the git ref from webhook payloads" },
		{ cwd: PROJ, lesson: "Gotcha: restart the hummin container to clear orphaned generations" },
	]);
	expect(recallLessons(PROJ, "zfs quota")).toHaveLength(1);
	expect(recallLessons(PROJ, "api gateway")).toHaveLength(1);
	// single 3-char term alone is enough for project scope
	expect(recallLessons(PROJ, "git")).toHaveLength(1);
});

test("exact phrase bonus ranks contiguous matches above scattered overlaps", () => {
	seedLessons([
		// 3 scattered query terms but no contiguous phrase
		{ cwd: PROJ, lesson: "Gotcha: docker volumes need recreate after quota changes, restart compose too" },
		// 2 overlapping terms plus the exact phrase "docker volume"
		{ cwd: PROJ, lesson: "Gotcha: a docker volume can silently hit the pool quota" },
	]);
	const lessons = recallLessons(PROJ, "docker volume quotas", 5);
	expect(lessons[0]).toBe("Gotcha: a docker volume can silently hit the pool quota");
});

test("recency bias ranks newer lessons above older ones on equal overlap", () => {
	const now = Date.now();
	const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" },
		{ cwd: PROJ, lesson: "Gotcha: stale docker compose state needs --force-recreate after mem_limit changes" },
	]);
	// rewrite with timestamps: first lesson is old, second is fresh
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${[
			{
				timestamp: iso(300 * 86_400_000),
				cwd: PROJ,
				lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes",
			},
			{
				timestamp: iso(0),
				cwd: PROJ,
				lesson: "Gotcha: stale docker compose state needs --force-recreate after mem_limit changes",
			},
		]
			.map((l) => JSON.stringify(l))
			.join("\n")}\n`,
	);
	// same overlap, no contiguous phrase: the fresh lesson wins
	const lessons = recallLessons(PROJ, "compose recreate mem_limit", 5);
	expect(lessons[0]).toBe("Gotcha: stale docker compose state needs --force-recreate after mem_limit changes");
	// and the bias cannot drown relevance: the zero-overlap lesson never appears
	expect(lessons).toHaveLength(2);
});

// --- Entity-linkage augmentation ---------------------------------------------

test("vault lessons are reachable through the titles of entities that cite them", () => {
	const vault = process.env.HUMMIN_MEMORY_VAULT_DIR!;
	mkdirSync(join(vault, "processed"), { recursive: true });
	mkdirSync(join(vault, "entities", "concept"), { recursive: true });
	writeFileSync(
		join(vault, "processed", "lesson-2026-09-18T10-00-00.md"),
		[
			"---",
			"type: lesson",
			"date: 2026-09-18",
			"project: alpha",
			"---",
			"",
			"Problem: ingest stalls under load.",
			"Approach: bounded queues between parser and sink.",
			"Gotcha: the sink drops batches silently when the channel is full.",
			"",
		].join("\n"),
	);
	// The entity cites the lesson by its slug, as the fold contract requires.
	writeFileSync(
		join(vault, "entities", "concept", "backpressure.md"),
		"# Backpressure\n\n- the ingest sink drops batches (from [[lesson-2026-09-18T10-00-00]], 2026-09-18)\n",
	);
	// The query shares no vocabulary with the lesson body: only the citing
	// entity's title terms can bridge the paraphrase gap.
	const lessons = recallLessons(PROJ, "backpressure handling", 3);
	expect(lessons).toHaveLength(1);
	expect(lessons[0]).toContain("ingest stalls under load");
});

// --- Usage stamping (lastInjectedAt) ----------------------------------------

const STAMP = "2026-09-24T00:00:00.000Z";

test("stampLessonLine stamps only matching lesson bodies and preserves other fields", () => {
	const line = JSON.stringify({ timestamp: "2026-01-01", cwd: PROJ, lesson: "Gotcha: docker compose", session: "s1" });
	const stamped = stampLessonLine(line, new Set(["Gotcha: docker compose"]), STAMP);
	const parsed = JSON.parse(stamped);
	expect(parsed.lastInjectedAt).toBe(STAMP);
	// every original field survives the rewrite
	expect(parsed).toEqual({
		timestamp: "2026-01-01",
		cwd: PROJ,
		lesson: "Gotcha: docker compose",
		session: "s1",
		lastInjectedAt: STAMP,
	});
});

test("stampLessonLine passes through non-matching, malformed, and non-lesson lines byte-identical", () => {
	const other = JSON.stringify({ cwd: PROJ, lesson: "unrelated lesson" });
	expect(stampLessonLine(other, new Set(["Gotcha: docker compose"]), STAMP)).toBe(other);
	expect(stampLessonLine("not json at all", new Set(["x"]), STAMP)).toBe("not json at all");
	expect(stampLessonLine(JSON.stringify({ cwd: PROJ }), new Set(["x"]), STAMP)).toBe(JSON.stringify({ cwd: PROJ }));
});

test("stampLessonLine refreshes an existing stamp and matches on trimmed bodies", () => {
	const line = JSON.stringify({ lesson: "Gotcha: docker compose", lastInjectedAt: "2020-01-01" });
	expect(JSON.parse(stampLessonLine(line, new Set(["Gotcha: docker compose"]), STAMP)).lastInjectedAt).toBe(STAMP);
	const padded = JSON.stringify({ lesson: "  Gotcha: docker compose  " });
	expect(JSON.parse(stampLessonLine(padded, new Set(["Gotcha: docker compose"]), STAMP)).lastInjectedAt).toBe(STAMP);
});

test("markLessonsInjected rewrites the store only for matching records and tolerates old records", () => {
	seedLessons([
		{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate" },
		{ cwd: PROJ, lesson: "Gotcha: restart the hummin container" },
	]);
	markLessonsInjected(["Gotcha: docker compose needs --force-recreate"]);
	const lines = readFileSync(join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"), "utf8").trim().split("\n");
	expect(JSON.parse(lines[0]).lastInjectedAt).toEqual(expect.any(String));
	expect(JSON.parse(lines[1]).lastInjectedAt).toBeUndefined();
});

test("markLessonsInjected is a no-op on an empty body list or a missing store", () => {
	expect(() => markLessonsInjected([])).not.toThrow();
	process.env.HUMMIN_MEMORY_DIR = mkdtempSync(join(tmpdir(), "hummin-recall-empty-"));
	createdDirs.push(process.env.HUMMIN_MEMORY_DIR);
	expect(() => markLessonsInjected(["anything"])).not.toThrow();
	expect(existsSync(join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"))).toBe(false);
});

test("searchVault stamps the lessons it returns", async () => {
	seedLessons([{ cwd: PROJ, lesson: "Gotcha: docker compose needs --force-recreate after mem_limit changes" }]);
	await searchVault("docker compose force-recreate", PROJ);
	const line = readFileSync(join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"), "utf8").trim().split("\n")[0];
	expect(JSON.parse(line).lastInjectedAt).toEqual(expect.any(String));
});

// --- Delta injection selection ----------------------------------------------

test("lessonIdOf is stable per lesson body and insensitive to surrounding whitespace", () => {
	expect(lessonIdOf("abc")).toBe(lessonIdOf("abc"));
	expect(lessonIdOf("  abc ")).toBe(lessonIdOf("abc"));
	expect(lessonIdOf("abc")).not.toBe(lessonIdOf("abd"));
	expect(lessonIdOf("abc")).toMatch(/^[0-9a-f]{16}$/);
});

test("assembleBriefing keeps ranked order, drops already-injected ids, and enforces the char cap", () => {
	const a = "short lesson a";
	const b = "short lesson b";
	const big = `huge lesson ${"x".repeat(300)}`;
	const c = "short lesson c";
	const injected = new Set([lessonIdOf(b)]);
	// b is already injected: excluded. big would overflow (a + big > 100) but
	// must not stop the smaller c from fitting.
	const parts = assembleBriefing([a, b, big, c], injected, 100);
	expect(parts.map((p) => p.lesson)).toEqual([a, c]);
	expect(parts[0].id).toBe(lessonIdOf(a));
});

test("assembleBriefing returns nothing when every top hit was already injected", () => {
	const a = "lesson about kubernetes";
	expect(assembleBriefing([a], new Set([lessonIdOf(a)]), 2000)).toEqual([]);
	expect(assembleBriefing([], new Set(), 2000)).toEqual([]);
});

test("injectedIdsFromEntries collects ids from recall message details only", () => {
	const recall = (lessonIds: unknown, details?: unknown) => ({
		type: "custom_message",
		customType: "hummin-memory-recall",
		details: details ?? { lessonIds },
	});
	const ids = injectedIdsFromEntries([
		recall(["aaa", "bbb"]),
		recall(["bbb", 42, null, "ccc"]), // non-string entries ignored
		{ type: "custom_message", customType: "other", details: { lessonIds: ["ddd"] } },
		{ type: "custom_message", customType: "hummin-memory-recall" }, // no details
		recall("not-an-array"), // malformed details ignored
		{ type: "message" }, // non-recall entry ignored
	]);
	expect([...ids].sort()).toEqual(["aaa", "bbb", "ccc"]);
});
