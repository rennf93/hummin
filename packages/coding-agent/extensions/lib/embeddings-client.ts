/**
 * Minimal OpenAI-shaped embeddings client and vector sidecar for hummin memory
 * hybrid retrieval. llama.cpp servers (and OpenAI) answer
 * POST /v1/embeddings {input: string[] | string} with {data: [{embedding: number[]}]};
 * this module speaks exactly that shape and nothing more.
 *
 * Everything fails open: callers treat a null result as "no embeddings this
 * pass" and fall back to plain BM25 ranking. Embedding bodies are never
 * logged; the only failure signal is the null return.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Transport for one /v1/embeddings call. Injectable so tests can stand in
 * for the server; the default uses global fetch with a hard timeout. */
export type EmbeddingsFetcher = (endpoint: string, input: readonly string[], timeoutMs: number) => Promise<unknown>;

/** Default transport: POST {input}, 5s-style AbortSignal timeout, JSON body. */
export async function defaultEmbeddingsFetcher(endpoint: string, input: readonly string[], timeoutMs: number): Promise<unknown> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input: [...input] }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`embeddings endpoint answered ${response.status}`);
	return await response.json();
}

/**
 * Pure: parse an OpenAI-shaped /v1/embeddings payload into one vector per
 * input entry. Returns null (never throws) on any shape violation: missing or
 * short data array, non-numeric or non-finite coordinates, ragged dimensions.
 * Entries carrying a numeric `index` (part of the OpenAI schema, which does
 * not guarantee order) are sorted by it, so vectors pair with the right
 * inputs even from servers that answer out of order.
 */
export function parseEmbeddingVectors(payload: unknown, count: number): number[][] | null {
	if (typeof payload !== "object" || payload === null) return null;
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length !== count) return null;
	const items = data.map((item, position) => ({ item, position }));
	const allIndexed = items.every(
		({ item }) => typeof (item as { index?: unknown } | null)?.index === "number",
	);
	if (allIndexed) {
		items.sort((a, b) => (a.item as { index: number }).index - (b.item as { index: number }).index);
	}
	const vectors: number[][] = [];
	for (const { item } of items) {
		if (typeof item !== "object" || item === null) return null;
		const embedding = (item as { embedding?: unknown }).embedding;
		if (!Array.isArray(embedding) || embedding.length === 0) return null;
		for (const coordinate of embedding) {
			if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return null;
		}
		vectors.push(embedding);
	}
	const dim = vectors[0]?.length ?? 0;
	for (const vector of vectors) {
		if (vector.length !== dim) return null;
	}
	return vectors;
}

/**
 * Embed one batch of inputs. Returns null on any failure (unreachable
 * endpoint, timeout, malformed reply, wrong count) - fail open to BM25-only.
 */
export async function embedInputs(input: readonly string[], endpoint: string, timeoutMs: number, fetcher: EmbeddingsFetcher = defaultEmbeddingsFetcher): Promise<number[][] | null> {
	if (input.length === 0) return null;
	try {
		return parseEmbeddingVectors(await fetcher(endpoint, input, timeoutMs), input.length);
	} catch {
		return null;
	}
}

/** Cosine similarity of two equal-length vectors; 0 for empty, mismatched
 * dimensions, or zero vectors (a zero vector carries no direction). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / Math.sqrt(normA * normB);
}

/** Round coordinates to `decimals` places so the sidecar stays compact. */
export function roundVector(vec: readonly number[], decimals: number): number[] {
	const factor = 10 ** decimals;
	return vec.map((coordinate) => Math.round(coordinate * factor) / factor);
}

/** One sidecar record: the lesson's body hash (lessonIdOf, first 16 hex of
 * sha256), its embedding rounded for storage, the dimension, and a stamp. */
export interface VectorRecord {
	key: string;
	vec: number[];
	dim: number;
	at: string;
}

function vectorRecordLine(record: VectorRecord): string {
	return JSON.stringify({ key: record.key, vec: record.vec, dim: record.dim, at: record.at });
}

/** Parse every well-formed sidecar line; malformed lines are skipped. */
export function readVectorRecords(path: string): VectorRecord[] {
	const records: VectorRecord[] = [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return records;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { key?: unknown; vec?: unknown; dim?: unknown; at?: unknown };
			if (typeof parsed.key !== "string") continue;
			if (!Array.isArray(parsed.vec) || parsed.vec.some((c) => typeof c !== "number")) continue;
			if (typeof parsed.dim !== "number" || typeof parsed.at !== "string") continue;
			records.push({ key: parsed.key, vec: parsed.vec as number[], dim: parsed.dim, at: parsed.at });
		} catch {
			// skip malformed line
		}
	}
	return records;
}

/** Sidecar index: key -> stored vector, for cosine lookups at retrieval time. */
export function loadVectorIndex(path: string): Map<string, number[]> {
	const index = new Map<string, number[]>();
	for (const record of readVectorRecords(path)) {
		if (!index.has(record.key)) index.set(record.key, record.vec);
	}
	return index;
}

/**
 * Append records to the sidecar, then cap the file at `maxBytes` by dropping
 * the OLDEST lines first (atomic tmp+rename rewrite, so a crash leaves the
 * previous file intact). Creates the parent directory.
 */
export function appendVectorRecords(path: string, records: readonly VectorRecord[], maxBytes: number): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	appendFileSync(path, `${records.map(vectorRecordLine).join("\n")}\n`, { mode: 0o600 });
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		return; // append failed; nothing to cap
	}
	if (size <= maxBytes) return;
	// Keep the newest lines that fit; the file order is append order (oldest first).
	const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
	const kept: string[] = [];
	let total = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const bytes = Buffer.byteLength(lines[i] + "\n");
		if (total + bytes > maxBytes) break;
		kept.unshift(lines[i]);
		total += bytes;
	}
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
	renameSync(temp, path);
}
