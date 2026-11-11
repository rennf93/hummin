/**
 * harness/replay-server: pure replay server over a fixture event log for the
 * remote console test harness. consume() returns exactly the shape the SSE
 * layer of a later phase will serve per request; simulateStream() plays a
 * fixture back as an async generator with optional pacing. No HTTP, no DOM.
 */
import { type RemoteEvent, type ReplayCursor, ReplayLog } from "./replay-log.ts";

/** Result of one replay request: a page of events, or the signal that the
 * consumer's cursor is unusable and a fresh snapshot must be served instead. */
export interface ConsumeResult {
	events: RemoteEvent[];
	needsSnapshot: boolean;
}

/** Options for the replay server. */
export interface ReplayServerOptions {
	/** Wall delay between simulated stream yields; 0 (the default) plays instantly. */
	delayMs?: number;
}

/** Serves replay pages from a log built over the given fixture events. */
export class ReplayServer {
	private log: ReplayLog;
	private snapshot: RemoteEvent | undefined;
	private delayMs: number;

	constructor(fixtures: RemoteEvent[], opts: ReplayServerOptions = {}) {
		const log = new ReplayLog();
		let snapshot: RemoteEvent | undefined;
		for (const event of fixtures) {
			log.append(event);
			if (!snapshot && event.type === "snapshot") snapshot = event;
		}
		this.log = log;
		this.snapshot = snapshot;
		this.delayMs = opts.delayMs ?? 0;
	}

	/** Serves up to count events after cursor. When the cursor is absent or
	 * predates the buffer, needsSnapshot is true and events carries the fixture's
	 * snapshot event for the caller to send (empty when the log has none). */
	consume(cursor: ReplayCursor | undefined, count: number): ConsumeResult {
		const snapshotEvents = this.snapshot ? [this.snapshot] : [];
		if (cursor === undefined) return { events: snapshotEvents, needsSnapshot: true };
		const replay = this.log.events_since(cursor);
		if (replay === undefined) return { events: snapshotEvents, needsSnapshot: true };
		return { events: replay.slice(0, Math.max(count, 0)), needsSnapshot: false };
	}

	/** Yields the fixture's events in order: its snapshot first, then its stream-variant
	 * events (message_start, text_delta chunks, message_end), pausing delayMs between
	 * yields. Seqs stay as baked in the fixture files, each file's own seq space. */
	async *simulateStream(fixture: RemoteEvent[]): AsyncGenerator<RemoteEvent> {
		for (const [index, event] of fixture.entries()) {
			if (index > 0 && this.delayMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
			}
			yield event;
		}
	}
}
