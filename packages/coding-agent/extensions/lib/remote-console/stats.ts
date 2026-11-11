/**
 * lib/remote-console/stats: session totals for WireStats. Re-implements the
 * footer's rules (src/modes/interactive/components/hummin-footer.ts,
 * aggregateEntry and computeTokenRate) as small pure pieces: the footer module
 * pulls in theme and TUI code, which an extension synced to
 * ~/.hummin/agent/extensions cannot import. Keep the rules in step with it.
 */
import type { WireStats } from "./protocol.ts";

/** Minimal structural view of a session entry; entries are trust-boundary
 * data (session files), so every field is checked before use. */
interface EntryLike {
	id?: unknown;
	type?: unknown;
	message?: unknown;
	usage?: unknown;
}

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Added and removed line counts of a unified diff text (footer's countDiffStat). */
export function countDiffStat(diffText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

interface Accumulator {
	count: number;
	lastId: unknown;
	firstId: unknown;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	sawUsage: boolean;
	added: number;
	removed: number;
	sawDiff: boolean;
	cacheHit: number | undefined;
	todos: { done: number; total: number } | undefined;
}

function emptyAccumulator(): Accumulator {
	return {
		count: 0,
		lastId: undefined,
		firstId: undefined,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		sawUsage: false,
		added: 0,
		removed: 0,
		sawDiff: false,
		cacheHit: undefined,
		todos: undefined,
	};
}

function addUsage(acc: Accumulator, usage: UsageLike): void {
	acc.input += num(usage.input);
	acc.output += num(usage.output);
	acc.cacheRead += num(usage.cacheRead);
	acc.cacheWrite += num(usage.cacheWrite);
	acc.cost += num(usage.cost?.total);
	acc.sawUsage = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function aggregate(acc: Accumulator, entry: EntryLike): void {
	const message = isRecord(entry.message) ? entry.message : undefined;
	if (entry.type === "usage" && isRecord(entry.usage)) {
		addUsage(acc, entry.usage as UsageLike);
		return;
	}
	if (entry.type === "message" && message?.role === "assistant" && isRecord(message.usage)) {
		const usage = message.usage as UsageLike;
		addUsage(acc, usage);
		const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
		if (prompt > 0) acc.cacheHit = (num(usage.cacheRead) / prompt) * 100;
		return;
	}
	if (entry.type === "message" && message?.role === "toolResult") {
		if (isRecord(message.usage)) addUsage(acc, message.usage as UsageLike);
		const details = isRecord(message.details) ? message.details : undefined;
		// edit stores a display diff; write stores precomputed counts
		if (typeof details?.added === "number" && typeof details.removed === "number") {
			acc.added += details.added;
			acc.removed += details.removed;
			acc.sawDiff = true;
		} else if (typeof details?.diff === "string" && details.diff !== "") {
			const stat = countDiffStat(details.diff);
			acc.added += stat.added;
			acc.removed += stat.removed;
			acc.sawDiff = true;
		}
		if (message.toolName === "todo" && Array.isArray(details?.todos)) {
			const items = details.todos as unknown[];
			acc.todos = {
				done: items.filter((item) => isRecord(item) && item.status === "completed").length,
				total: items.length,
			};
		}
		return;
	}
	if ((entry.type === "branch_summary" || entry.type === "compaction") && isRecord(entry.usage)) {
		addUsage(acc, entry.usage as UsageLike);
	}
}

/** Incremental session stats over an entry list (the whole session file or
 * one branch). Both grow by appending, so entries [0, n-1) are folded once and
 * reused while the list still extends the scanned prefix; any other shape
 * (shrunk list, changed first id, tree navigation, compaction rewrite)
 * rescans. The final entry is folded fresh on every compute because its usage
 * can still change after it first appears (the terminal footer re-folds it on
 * every render for the same reason). The cost of a publish is therefore the
 * new entries, not the session length. */
export class SessionStatsCache {
	private acc = emptyAccumulator();

	/** WireStats fields derivable from the branch (tokensPerSecond is the
	 * caller's). Each field is omitted when the branch holds no source for it. */
	compute(branch: readonly EntryLike[]): WireStats {
		const stable = branch.length - 1;
		const cached = this.acc;
		const reusable =
			cached.count > 0 &&
			stable >= cached.count &&
			branch[0]?.id === cached.firstId &&
			branch[cached.count - 1]?.id === cached.lastId;
		if (!reusable) this.acc = emptyAccumulator();
		const prefix = this.acc;
		for (let i = prefix.count; i < stable; i++) aggregate(prefix, branch[i] as EntryLike);
		prefix.count = Math.max(stable, 0);
		prefix.firstId = branch[0]?.id;
		prefix.lastId = branch[stable - 1]?.id;
		const state = structuredClone(prefix);
		if (branch.length > 0) aggregate(state, branch[stable] as EntryLike);
		const stats: WireStats = {};
		if (state.sawUsage) {
			stats.tokens = {
				input: state.input,
				output: state.output,
				cacheRead: state.cacheRead,
				cacheWrite: state.cacheWrite,
			};
			stats.costUsd = state.cost;
		}
		if (state.cacheHit !== undefined) stats.cacheHitPercent = state.cacheHit;
		if (state.sawDiff) stats.diff = { added: state.added, removed: state.removed };
		if (state.todos) stats.todos = { ...state.todos };
		return stats;
	}
}

/** Live tok/s of the streaming assistant message: smoothed (EMA) growth of
 * usage.output between samples, like the footer's computeTokenRate. Samples
 * closer than MIN_SAMPLE_MS are skipped so per-token events do not make the
 * rate jittery. */
export class TokenRateTracker {
	private static readonly SMOOTHING = 0.35;
	private static readonly MIN_SAMPLE_MS = 250;
	private prev: { output: number; at: number } | undefined;
	private smoothed: number | undefined;

	/** Feed the streaming message's usage.output at time `now` (ms). */
	sample(output: number, now: number): void {
		if (!this.prev) {
			this.prev = { output, at: now };
			return;
		}
		const dtSeconds = (now - this.prev.at) / 1000;
		if (dtSeconds * 1000 < TokenRateTracker.MIN_SAMPLE_MS) return;
		const delta = output - this.prev.output;
		this.prev = { output, at: now };
		if (delta <= 0) return;
		const raw = delta / dtSeconds;
		this.smoothed =
			this.smoothed === undefined
				? raw
				: TokenRateTracker.SMOOTHING * raw + (1 - TokenRateTracker.SMOOTHING) * this.smoothed;
	}

	/** Current rate, or null when nothing streams or no rate was measured yet. */
	get rate(): number | null {
		return this.smoothed ?? null;
	}

	/** Nothing streams any more (message end, turn end, settle). */
	reset(): void {
		this.prev = undefined;
		this.smoothed = undefined;
	}
}
