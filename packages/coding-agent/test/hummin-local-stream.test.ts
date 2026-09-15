import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { serializedLocalStream } from "../extensions/hummin-local.ts";

const model = {
	id: "test",
	provider: "local-test",
	api: "openai-completions",
	baseUrl: "http://localhost:19000/v1",
} as Model<Api>;
let directory: string;
let original: string | undefined;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hummin-stream-"));
	original = process.env.HUMMIN_CODING_AGENT_DIR;
	process.env.HUMMIN_CODING_AGENT_DIR = directory;
});
afterEach(() => {
	if (original === undefined) delete process.env.HUMMIN_CODING_AGENT_DIR;
	else process.env.HUMMIN_CODING_AGENT_DIR = original;
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
