import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { serializedLocalStream } from "../extensions/hummin-local.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const model = {
	id: "test",
	provider: "local-test",
	api: "openai-completions",
	baseUrl: "http://localhost:19000/v1",
} as Model<Api>;
const modelB = {
	id: "test-b",
	provider: "local-test-b",
	api: "openai-completions",
	baseUrl: "http://localhost:19001/v1",
} as Model<Api>;
let directory: string;
let original: string | undefined;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-stream-"));
	original = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = directory;
});
afterEach(() => {
	if (original === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = original;
	rmSync(directory, { recursive: true, force: true });
});

it("completes thrown and unterminated streams as errors instead of hanging", async () => {
	const thrown = serializedLocalStream(model, undefined, () => {
		throw new Error("connection lost");
	});
	expect((await thrown.result()).errorMessage).toContain("connection lost");
	const empty = serializedLocalStream(model, undefined, () => {
		const stream = createAssistantMessageEventStream();
		stream.end();
		return stream;
	});
	expect((await empty.result()).errorMessage).toContain("without a terminal event");
});

it("holds the lock until completion and cancels queued requests before generation", async () => {
	const firstSource = createAssistantMessageEventStream();
	let entered = false;
	const first = serializedLocalStream(model, undefined, () => {
		entered = true;
		return firstSource;
	});
	await expect.poll(() => entered).toBe(true);
	const controller = new AbortController();
	let queuedEntered = false;
	const second = serializedLocalStream(model, controller.signal, () => {
		queuedEntered = true;
		return createAssistantMessageEventStream();
	});
	controller.abort();
	expect((await second.result()).stopReason).toBe("aborted");
	expect(queuedEntered).toBe(false);
	firstSource.push({ type: "done", reason: "stop", message: fauxAssistantMessage("first") });
	await first.result();
	const last = serializedLocalStream(model, undefined, () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("last") });
		return stream;
	});
	expect((await last.result()).stopReason).toBe("stop");
});

it("cancels busy backoff without another generation", async () => {
	const controller = new AbortController();
	let calls = 0;
	const stream = serializedLocalStream(model, controller.signal, () => {
		calls++;
		const source = createAssistantMessageEventStream();
		source.push({
			type: "error",
			reason: "error",
			error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 busy" }),
		});
		return source;
	});
	await expect.poll(() => calls).toBe(1);
	controller.abort();
	expect((await stream.result()).stopReason).toBe("aborted");
	expect(calls).toBe(1);
});

const fastOptions = { busyBaseDelayMs: 1, maxBusyRetries: 2 } as const;

function errorStream(errorMessage: string) {
	const source = createAssistantMessageEventStream();
	source.push({
		type: "error",
		reason: "error",
		error: fauxAssistantMessage("", { stopReason: "error", errorMessage }),
	});
	return source;
}

it("fails over to the next candidate on a connectivity error before any content", async () => {
	const seen: string[] = [];
	const failovers: Array<[string, string]> = [];
	const stream = serializedLocalStream(
		[model, modelB],
		undefined,
		(candidate) => {
			seen.push(candidate.id);
			if (candidate === model) return errorStream("fetch failed: Connection refused");
			const source = createAssistantMessageEventStream();
			source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("from b") });
			return source;
		},
		{ ...fastOptions, onFailover: (from, to) => failovers.push([from.id, to.id]) },
	);
	const result = await stream.result();
	expect(seen).toEqual(["test", "test-b"]);
	expect(failovers).toEqual([["test", "test-b"]]);
	expect(result.stopReason).toBe("stop");
});

it("fails over on busy exhaustion and on thrown connectivity errors", async () => {
	const calls: string[] = [];
	const stream = serializedLocalStream(
		[model, modelB],
		undefined,
		(candidate) => {
			calls.push(candidate.id);
			if (candidate === model) return errorStream("server busy, try later");
			throw new Error("connection lost");
		},
		{ ...fastOptions, onFailover: () => {} },
	);
	const result = await stream.result();
	// busy retries exhaust on A (maxBusyRetries 2 -> 3 calls), then B throws
	expect(calls.filter((id) => id === "test")).toHaveLength(3);
	expect(calls.filter((id) => id === "test-b")).toHaveLength(1);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("connection lost");
});

it("does not fail over after content was emitted or on non-connectivity errors", async () => {
	const calls: string[] = [];
	const partial = createAssistantMessageEventStream();
	partial.push({ type: "text", delta: "partial" } as never);
	partial.push({
		type: "error",
		reason: "error",
		error: fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "fetch failed: Connection refused" }),
	});
	const stream = serializedLocalStream([model, modelB], undefined, (candidate) => {
		calls.push(candidate.id);
		if (candidate === model) return partial;
		return errorStream("HTTP 400 bad request");
	});
	const result = await stream.result();
	expect(calls).toEqual(["test"]);
	expect(result.stopReason).toBe("error");
});
