import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import {
	recallLessons,
	recallLessonsHybrid,
	resetEmbedCachesForTests,
	searchVault,
} from "../extensions/hummin-memory.ts";
import {
	appendVectorRecords,
	cosineSimilarity,
	parseEmbeddingVectors,
	type VectorRecord,
} from "../extensions/lib/embeddings-client.ts";

const originals = new Map<string, string | undefined>();
const createdDirs: string[] = [];

function pinEnv(key: string, value: string): void {
	if (!originals.has(key)) originals.set(key, process.env[key]);
	process.env[key] = value;
}

/** Restore every pinned key to its pre-file value (tests set env directly, so
 * this must run between tests or a later test inherits an earlier one's
 * endpoint or gate). */
function restorePinnedEnv(): void {
	for (const [key, value] of originals) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

beforeEach(() => {
	// Expansion (a model call) stays off: this suite pins embedding behavior.
	pinEnv("HUMMIN_MEMORY_QUERY_EXPAND", "0");
	const memoryDir = mkdtempSync(join(tmpdir(), "hummin-embed-memory-"));
	const vaultDir = mkdtempSync(join(tmpdir(), "hummin-embed-vault-"));
	pinEnv("HUMMIN_MEMORY_DIR", memoryDir);
	pinEnv("HUMMIN_MEMORY_VAULT_DIR", vaultDir);
	createdDirs.push(memoryDir, vaultDir);
	resetEmbedCachesForTests();
});

afterEach(() => {
	resetEmbedCachesForTests();
	restorePinnedEnv();
});

afterAll(async () => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	restorePinnedEnv();
});

const PROJ = "/Users/renzof/work/alpha";

function seedLessons(lessons: string[]): void {
	writeFileSync(
		join(process.env.HUMMIN_MEMORY_DIR!, "lessons.jsonl"),
		`${lessons.map((lesson) => JSON.stringify({ cwd: PROJ, lesson })).join("\n")}\n`,
	);
}

/** Local stand-in for the OpenAI-shaped embeddings endpoint: one fixed vector
 * per input text (unknown texts get a vector orthogonal to [1,0,0]). */
function startEmbeddingsServer(
	vectors: Map<string, number[]>,
): Promise<{ server: Server; url: string; requests: string[][] }> {
	return new Promise((resolve) => {
		const requests: string[][] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk;
			});
			req.on("end", () => {
				let input: string[] = [];
				try {
					const parsed = JSON.parse(body) as { input?: unknown };
					if (Array.isArray(parsed.input)) input = parsed.input as string[];
				} catch {
					input = [];
				}
				requests.push(input);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: input.map((text) => ({ embedding: vectors.get(text) ?? [0, 0, 1] })) }));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ server, url: `http://127.0.0.1:${port}/v1/embeddings`, requests });
		});
	});
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

// --- Client units -------------------------------------------------------------

test("parseEmbeddingVectors accepts the OpenAI shape and rejects malformed payloads", () => {
	expect(parseEmbeddingVectors({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, 2)).toEqual([
		[1, 2],
		[3, 4],
	]);
	expect(parseEmbeddingVectors({ data: [{ embedding: [1] }] }, 2)).toBeNull(); // count mismatch
	expect(parseEmbeddingVectors({ data: [{ embedding: [1] }, { embedding: [2, 3] }] }, 2)).toBeNull(); // ragged
	expect(parseEmbeddingVectors({ data: [{ embedding: [1, "x"] }] }, 1)).toBeNull(); // non-numeric
	expect(parseEmbeddingVectors({ data: [{ embedding: [] }] }, 1)).toBeNull(); // empty vector
	expect(parseEmbeddingVectors({ data: "nope" }, 1)).toBeNull();
	expect(parseEmbeddingVectors(null, 1)).toBeNull();
});

test("parseEmbeddingVectors honors the index field when entries arrive out of order", () => {
	// The OpenAI schema does not guarantee data order; a server that answers
	// out of order must not silently mispair vectors with their inputs.
	const payload = {
		data: [
			{ index: 1, embedding: [3, 4] },
			{ index: 0, embedding: [1, 2] },
		],
	};
	expect(parseEmbeddingVectors(payload, 2)).toEqual([
		[1, 2],
		[3, 4],
	]);
	// Unindexed payloads keep position order.
	expect(parseEmbeddingVectors({ data: [{ embedding: [9] }, { embedding: [8] }] }, 2)).toEqual([[9], [8]]);
});

test("cosineSimilarity is 1 for identical vectors, 0 for orthogonal, zero, and mismatched dims", () => {
	expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
	expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
	expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
	expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
	expect(cosineSimilarity([], [])).toBe(0);
});

test("appendVectorRecords caps the sidecar by dropping the oldest lines", () => {
	const path = join(process.env.HUMMIN_MEMORY_DIR!, "vectors.jsonl");
	const records: VectorRecord[] = Array.from({ length: 10 }, (_, i) => ({
		key: `key-${i}`,
		vec: [i, 0, i],
		dim: 3,
		at: "2026-09-26T00:00:00.000Z",
	}));
	appendVectorRecords(path, records, 500);
	const text = readFileSync(path, "utf8");
	expect(text.length).toBeLessThanOrEqual(500);
	const lines = text.trim().split("\n");
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.length).toBeLessThan(10);
	// The oldest lines dropped; every survivor parses and the newest key stays.
	const keys = lines.map((line) => JSON.parse(line).key as string);
	expect(keys).not.toContain("key-0");
	expect(keys.at(-1)).toBe("key-9");
});

// --- Hybrid scoring -------------------------------------------------------------

const LESSON_TOP =
	"Problem: quota gates writes silently. Approach: raise the quota. Gotcha: always reserve headroom first.";
const LESSON_SECOND = "Problem: quota gates writes. Approach: raise quota. Gotcha: reserve headroom.";
const LESSON_WEAK = "Problem: quota headroom shrinks. Approach: monitor. Gotcha: check weekly.";
const QUERY = "quota gates writes";

test("bm25-only ranking is the hybrid baseline", () => {
	seedLessons([LESSON_TOP, LESSON_SECOND, LESSON_WEAK]);
	// Plain BM25: the top two are a near-tie, the third is far behind.
	const lessons = recallLessons(PROJ, QUERY, 5);
	expect(lessons).toEqual([LESSON_TOP, LESSON_SECOND, LESSON_WEAK]);
});

test("hybrid scoring lets a vector-close paraphrase overtake the bm25 leader", () => {
	seedLessons([LESSON_TOP, LESSON_SECOND, LESSON_WEAK]);
	// LESSON_SECOND trails LESSON_TOP by a small normalized margin; a cosine of
	// 1 with weight HYBRID_EMBED_ALPHA=0.4 must flip the pair, while LESSON_TOP's
	// orthogonal vector leaves it on its BM25 rank.
	const similarity = new Map<string, number>([
		[LESSON_TOP, 0],
		[LESSON_SECOND, 1],
	]);
	const lessons = recallLessons(PROJ, QUERY, 5, "project", [], similarity);
	expect(lessons).toEqual([LESSON_SECOND, LESSON_TOP, LESSON_WEAK]);
});

test("relevance floors still hold under hybrid scoring", () => {
	seedLessons([LESSON_TOP]);
	// A lesson with zero query-term overlap never enters the candidate set, no
	// matter how close its vector would be.
	const similarity = new Map<string, number>([["Problem: unrelated body text entirely", 1]]);
	const lessons = recallLessons(PROJ, QUERY, 5, "project", [], similarity);
	expect(lessons).toEqual([LESSON_TOP]);
});

// --- Endpoint resolution + integration -----------------------------------------

test("hybrid search beats bm25-only on a paraphrase via a live fake endpoint", async () => {
	const vectors = new Map<string, number[]>([
		[QUERY, [1, 0, 0]],
		[LESSON_TOP, [0, 1, 0]],
		[LESSON_SECOND, [1, 0, 0]],
	]);
	const stub = await startEmbeddingsServer(vectors);
	try {
		pinEnv("HUMMIN_MEMORY_EMBED_URL", stub.url);
		// Three lessons, as in the pure test above: min-max normalization needs
		// the weak third candidate for the near-tie pair to be flippable
		// (alpha 0.4 can never close a full 1.0 normalized gap).
		seedLessons([LESSON_TOP, LESSON_SECOND, LESSON_WEAK]);
		// The wiring produces the same flip the pure test above pins.
		expect(await recallLessonsHybrid(PROJ, QUERY, 5)).toEqual([LESSON_SECOND, LESSON_TOP, LESSON_WEAK]);
		// End-to-end through the vault tool search.
		const result = await searchVault(QUERY, PROJ);
		expect(result.indexOf(LESSON_SECOND)).toBeGreaterThanOrEqual(0);
		expect(result.indexOf(LESSON_SECOND)).toBeLessThan(result.indexOf(LESSON_TOP));
		// Sidecar record shape: hash key, rounded vector, dim, stamp.
		const sidecar = join(process.env.HUMMIN_MEMORY_DIR!, "vectors.jsonl");
		expect(existsSync(sidecar)).toBe(true);
		const lines = readFileSync(sidecar, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		const parsed = JSON.parse(lines[0]) as { key: string; vec: number[]; dim: number; at: string };
		expect(parsed.key).toMatch(/^[0-9a-f]{16}$/);
		expect(parsed.dim).toBe(3);
		expect(parsed.vec).toHaveLength(3);
		expect(typeof parsed.at).toBe("string");
	} finally {
		await closeServer(stub.server);
	}
});

test("hybrid retrieval fails open to bm25-only when the endpoint is dead", async () => {
	seedLessons([LESSON_TOP, LESSON_SECOND]);
	// Nothing listens here: the probe fails, the endpoint resolves to none.
	pinEnv("HUMMIN_MEMORY_EMBED_URL", "http://127.0.0.1:9/v1/embeddings");
	expect(await recallLessonsHybrid(PROJ, QUERY, 5)).toEqual([LESSON_TOP, LESSON_SECOND]);
});

test("hybrid retrieval is disabled by HUMMIN_MEMORY_EMBED=0 even with a live endpoint", async () => {
	const stub = await startEmbeddingsServer(new Map());
	try {
		pinEnv("HUMMIN_MEMORY_EMBED", "0");
		pinEnv("HUMMIN_MEMORY_EMBED_URL", stub.url);
		seedLessons([LESSON_TOP, LESSON_SECOND]);
		expect(await recallLessonsHybrid(PROJ, QUERY, 5)).toEqual([LESSON_TOP, LESSON_SECOND]);
		expect(stub.requests).toHaveLength(0);
	} finally {
		await closeServer(stub.server);
	}
});

test("backfill embeds at most 64 un-embedded lessons per retrieval pass", async () => {
	const stub = await startEmbeddingsServer(new Map());
	try {
		pinEnv("HUMMIN_MEMORY_EMBED_URL", stub.url);
		const lessons = Array.from(
			{ length: 70 },
			(_, i) => `Problem: distinct topic number ${i} with unique token zzz${i}.`,
		);
		seedLessons(lessons);
		await recallLessonsHybrid(PROJ, "distinct topic zzz0", 5);
		// First pass: probe, query embedding, then one bounded batch of 64.
		expect(stub.requests.map((input) => input.length)).toEqual([1, 1, 64]);
		const sidecar = join(process.env.HUMMIN_MEMORY_DIR!, "vectors.jsonl");
		expect(readFileSync(sidecar, "utf8").trim().split("\n")).toHaveLength(64);
		// Second pass embeds only the remaining 6.
		await recallLessonsHybrid(PROJ, "distinct topic zzz69", 5);
		expect(stub.requests.map((input) => input.length)).toEqual([1, 1, 64, 1, 6]);
		expect(readFileSync(sidecar, "utf8").trim().split("\n")).toHaveLength(70);
	} finally {
		await closeServer(stub.server);
	}
});

test("a stored vector with mismatched dimension is skipped, not trusted", async () => {
	const vectors = new Map<string, number[]>([
		[QUERY, [1, 0, 0]],
		[LESSON_TOP, [0, 1, 0]],
		[LESSON_SECOND, [1, 0, 0]],
	]);
	const stub = await startEmbeddingsServer(vectors);
	try {
		pinEnv("HUMMIN_MEMORY_EMBED_URL", stub.url);
		seedLessons([LESSON_TOP, LESSON_SECOND]);
		// Pre-seed the sidecar with a stale dim-2 vector for LESSON_SECOND: the
		// record exists, so no re-embed happens, and the lookup must skip it
		// (dimension mismatch) instead of scoring garbage.
		const key = createHash("sha256").update(LESSON_SECOND.trim()).digest("hex").slice(0, 16);
		writeFileSync(
			join(process.env.HUMMIN_MEMORY_DIR!, "vectors.jsonl"),
			`${JSON.stringify({ key, vec: [1, 0], dim: 2, at: "2026-09-26T00:00:00.000Z" })}\n`,
		);
		expect(await recallLessonsHybrid(PROJ, QUERY, 5)).toEqual([LESSON_TOP, LESSON_SECOND]);
	} finally {
		await closeServer(stub.server);
	}
});
