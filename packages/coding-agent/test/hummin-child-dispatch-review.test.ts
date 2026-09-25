import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ChildDispatchInput,
	createLayaChoiceCall,
	type DispatchReceipt,
	listChildDispatchReviews,
	prepareChildDispatch,
	resolveChildDispatchReview,
} from "../extensions/lib/child-dispatch-review.ts";

const tempDirs: string[] = [];
const profile = (provider: string, modelId: string, description: string) => ({
	provider,
	modelId,
	description,
	speed: "normal",
	cost: { input: 1, output: 2 },
});

function model(id: string, thinkingLevels: string[]): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "zai",
		baseUrl: "http://example.invalid",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: thinkingLevels.length > 1,
		thinkingLevelMap: Object.fromEntries(thinkingLevels.map((level) => [level, level])),
		contextWindow: 131072,
		maxTokens: 8192,
	} as Model<Api>;
}

function setup() {
	const agentDir = mkdtempSync(join(tmpdir(), "hummin-child-review-"));
	tempDirs.push(agentDir);
	const models = [
		model("base", ["off"]),
		model("pro", ["off", "medium"]),
		model("max", ["off", "medium", "high"]),
	] as const;
	const ctx = { modelRegistry: { getAvailable: () => models } };
	const input: ChildDispatchInput = {
		kind: "task",
		prompt: "implement the concurrency fix",
		cwd: "/tmp/project",
		model: "zai/base",
		thinking: "off",
	};
	const options = {
		agentDir,
		config: { enabled: true, swingThreshold: 0.6 },
		profiles: [
			profile("zai", "base", "routine"),
			profile("zai", "pro", "multi-step"),
			profile("zai", "max", "difficult"),
		],
	};
	return { agentDir, ctx, input, options };
}

function laya(answer: string, p: number, calls: string[] = []) {
	return async (state: string, questions: { criteria: string[] }[]) => {
		calls.push(`${state}\n${questions[0]?.criteria.join("|") ?? ""}`);
		return [{ answer, p }];
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("child dispatch review lifecycle", () => {
	it("allows an ordinary dispatch and reuses its receipt without another Laya call", async () => {
		const { ctx, input, options } = setup();
		const calls: string[] = [];
		const first = await prepareChildDispatch(input, ctx, {
			...options,
			laya: laya("zai/base [thinking=off]", 0.9, calls),
		});
		expect(first.action).toBe("allow");
		expect(first.receipt?.configuration).toEqual({ provider: "zai", modelId: "base", thinking: "off" });
		const second = await prepareChildDispatch(input, ctx, { ...options, laya: laya("invalid", 0.9, calls) });
		expect(second.action).toBe("allow");
		expect(calls).toHaveLength(1);
	});

	it("keeps the original configuration for an advisory recommendation", async () => {
		const { ctx, input, options } = setup();
		const calls: string[] = [];
		const first = await prepareChildDispatch(input, ctx, {
			...options,
			laya: laya("zai/pro [thinking=medium]", 0.4, calls),
		});
		expect(first.action).toBe("advisory");
		expect(first.configuration).toEqual({ provider: "zai", modelId: "base", thinking: "off" });
		const second = await prepareChildDispatch(input, ctx, { ...options, laya: laya("invalid", 0.9, calls) });
		expect(second.action).toBe("allow");
		expect(second.configuration).toEqual(first.configuration);
		expect(calls).toHaveLength(1);
	});

	it("holds a strong recommendation without implicit approval", async () => {
		const { ctx, input, options } = setup();
		const calls: string[] = [];
		const held = await prepareChildDispatch(input, ctx, {
			...options,
			laya: laya("zai/pro [thinking=medium]", 0.95, calls),
		});
		expect(held.action).toBe("block");
		expect(held.reason).toContain(held.reviewId);
		// The hold must carry the concrete same-provider recommendation.
		expect(held.reason).toContain("zai/pro [thinking=medium]");
		const retry = await prepareChildDispatch(input, ctx, { ...options, laya: laya("invalid", 0.95, calls) });
		expect(retry.action).toBe("block");
		expect(calls).toHaveLength(1);
	});

	it("accepts the recommendation, then lets the recommended tuple retry", async () => {
		const { agentDir, ctx, input, options } = setup();
		const _held = await prepareChildDispatch(input, ctx, {
			...options,
			laya: laya("zai/pro [thinking=medium]", 0.95),
		});
		const review = listChildDispatchReviews(agentDir)[0]!;
		resolveChildDispatchReview(
			review.receipt.reviewId,
			"Accept the reviewed stronger configuration.",
			agentDir,
			"accept",
		);
		const original = await prepareChildDispatch({ ...input, reviewId: review.receipt.reviewId }, ctx, {
			...options,
			laya: laya("invalid", 0.95),
		});
		expect(original.action).toBe("allow");
		expect(original.configuration).toEqual({ provider: "zai", modelId: "pro", thinking: "medium" });
		const recommended = await prepareChildDispatch({ ...input, model: "zai/pro", thinking: "medium" }, ctx, {
			...options,
			laya: laya("invalid", 0.95),
		});
		expect(recommended.action).toBe("allow");
	});

	it("accepts a reasoned override while preserving the original tuple", async () => {
		const { agentDir, ctx, input, options } = setup();
		await prepareChildDispatch(input, ctx, { ...options, laya: laya("zai/pro [thinking=medium]", 0.95) });
		const review = listChildDispatchReviews(agentDir)[0]!;
		resolveChildDispatchReview(
			review.receipt.reviewId,
			"The child must preserve the selected low-latency model.",
			agentDir,
			"override",
		);
		const result = await prepareChildDispatch({ ...input, reviewId: review.receipt.reviewId }, ctx, {
			...options,
			laya: laya("invalid", 0.95),
		});
		expect(result.action).toBe("allow");
		expect(result.configuration).toEqual({ provider: "zai", modelId: "base", thinking: "off" });
	});

	it("survives module restart because the pending decision is disk-backed", async () => {
		const { ctx, input, options } = setup();
		const held = await prepareChildDispatch(input, ctx, {
			...options,
			laya: laya("zai/pro [thinking=medium]", 0.95),
		});
		const restarted = await prepareChildDispatch(input, ctx, { ...options, laya: laya("invalid", 0.95) });
		expect(held?.reviewId).toBeTruthy();
		expect(restarted.action).toBe("block");
		expect(restarted.reviewId).toBe(held?.reviewId);
	});

	it("blocks forged, unknown, changed, offline, and unsupported receipts", async () => {
		const { agentDir, ctx, input, options } = setup();
		await prepareChildDispatch(input, ctx, { ...options, laya: laya("zai/pro [thinking=medium]", 0.95) });
		const review = listChildDispatchReviews(agentDir)[0]!;
		await expect(prepareChildDispatch({ ...input, reviewId: "unknown" }, ctx, options)).resolves.toMatchObject({
			action: "block",
		});
		const forged: DispatchReceipt = { ...review.receipt, fingerprint: "forged" };
		await expect(prepareChildDispatch({ ...input, receipt: forged }, ctx, options)).resolves.toMatchObject({
			action: "block",
		});
		for (const changed of [
			{ prompt: "different", cwd: input.cwd, kind: input.kind },
			{ prompt: input.prompt, cwd: "/tmp/other", kind: input.kind },
			{ prompt: input.prompt, cwd: input.cwd, kind: "cron" as const },
		]) {
			await expect(
				prepareChildDispatch({ ...input, ...changed, reviewId: review.receipt.reviewId }, ctx, options),
			).resolves.toMatchObject({ action: "block" });
		}
		const offlineCtx = { modelRegistry: { getAvailable: () => [model("base", ["off"]), model("pro", ["off"])] } };
		await expect(
			prepareChildDispatch(
				{ ...input, model: "zai/pro", thinking: "medium", reviewId: review.receipt.reviewId },
				offlineCtx,
				options,
			),
		).resolves.toMatchObject({ action: "block" });
	});

	it("keeps concurrent independent pending reviews", async () => {
		const { agentDir, ctx, options } = setup();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = async (_state: string, questions: { criteria: string[] }[]) => {
			await gate;
			return [{ answer: questions[0]!.criteria[1]!, p: 0.95 }];
		};
		const a = prepareChildDispatch(
			{ kind: "task", prompt: "first independent review", cwd: "/tmp/a", model: "zai/base", thinking: "off" },
			ctx,
			{ ...options, laya: slow },
		);
		const b = prepareChildDispatch(
			{ kind: "task", prompt: "second independent review", cwd: "/tmp/b", model: "zai/base", thinking: "off" },
			ctx,
			{ ...options, laya: slow },
		);
		release!();
		const results = await Promise.all([a, b]);
		expect(results.every((result) => result.action === "block")).toBe(true);
		expect(listChildDispatchReviews(agentDir)).toHaveLength(2);
	});

	it("parses exact choice probability from the real HTTP adapter", async () => {
		const originalFetch = globalThis.fetch;
		const requests: unknown[] = [];
		globalThis.fetch = (async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return new Response(
				JSON.stringify({
					answers: {
						recommended_configuration: {
							choice: "zai/base [thinking=off]",
							probabilities: { "zai/base [thinking=off]": 0.73 },
						},
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		try {
			process.env.HUMMIN_LAYA_URL = "http://mock.invalid";
			const result = await createLayaChoiceCall("state", [
				{
					name: "recommended_configuration",
					type: "choice",
					instructions: "choose",
					criteria: ["zai/base [thinking=off]"],
				},
			]);
			expect(result).toEqual([
				{
					answer: "zai/base [thinking=off]",
					p: 0.73,
					probabilities: { "zai/base [thinking=off]": 0.73 },
				},
			]);
			expect(requests).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
			delete process.env.HUMMIN_LAYA_URL;
		}
	});
});
