import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildContextReport,
	buildCostReport,
	cacheHitRatioOf,
	conversationTokensOf,
	estimateTokens,
	estimateToolTokens,
	formatContextReport,
	formatCostReport,
	isLocalProvider,
	type ModelPriceSource,
	messageCost,
	type UsageLike,
} from "../extensions/hummin-usage.ts";

const rates = (over: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>) => ({
	input: 1,
	output: 2,
	cacheRead: 0.1,
	cacheWrite: 1.25,
	...over,
});

const models: ModelPriceSource = {
	getModel: (provider, modelId) => {
		const key = `${provider}/${modelId}`;
		if (key === "zai/glm") return { cost: rates({ input: 1, output: 2 }) };
		if (key === "hummin/qwen-local") return { cost: rates({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) };
		return undefined;
	},
};

function usage(over: Partial<UsageLike>): UsageLike {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over };
}

describe("estimateTokens", () => {
	it("divides chars by 4, rounding up", () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(1)).toBe(1);
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(4001)).toBe(1001);
	});
});

describe("estimateToolTokens", () => {
	it("sums schema + description chars / 4", () => {
		const tool = {
			description: "abcd", // 4 chars -> 1
			parameters: { type: "object", properties: { path: { type: "string" } } },
			promptGuidelines: undefined,
		};
		const expected = Math.ceil((JSON.stringify(tool.parameters).length + 4) / 4);
		expect(estimateToolTokens(tool)).toBe(expected);
	});
});

describe("conversationTokensOf / cacheHitRatioOf", () => {
	it("conversation = input + cacheRead + cacheWrite", () => {
		expect(conversationTokensOf(usage({ input: 10, cacheRead: 100, cacheWrite: 20 }))).toBe(130);
	});

	it("returns null when nothing was billed or no usage exists", () => {
		expect(conversationTokensOf(undefined)).toBeNull();
		expect(conversationTokensOf(usage({}))).toBeNull();
	});

	it("cache hit = cacheRead / total billed, first-class prefill number", () => {
		expect(cacheHitRatioOf(usage({ input: 0, cacheRead: 900, cacheWrite: 100 }))).toBeCloseTo(0.9);
	});

	it("cache hit null when denominator is zero", () => {
		expect(cacheHitRatioOf(usage({}))).toBeNull();
		expect(cacheHitRatioOf(undefined)).toBeNull();
	});
});

describe("buildContextReport", () => {
	it("labels system prompt and tools est, conversation exact from usage", () => {
		const report = buildContextReport({
			systemPromptChars: 4000,
			tools: [{ name: "t", description: "abcd", parameters: {} }] as unknown as ToolInfo[],
			lastUsage: usage({ input: 500, cacheRead: 4000, cacheWrite: 500 }),
			contextWindow: 131072,
			reserveTokens: 16384,
		});
		const byLabel = Object.fromEntries(report.rows.map((row) => [row.label, row]));
		expect(byLabel["system prompt"].precision).toBe("est");
		expect(byLabel["system prompt"].tokens).toBe(1000);
		expect(byLabel.tools.precision).toBe("est");
		expect(byLabel.conversation.precision).toBe("exact");
		expect(report.conversationTokens).toBe(5000);
		expect(report.remainingTokens).toBe(131072 - 5000);
		expect(report.compactionTrigger).toBe(131072 - 16384);
	});

	it("falls back to est when no assistant usage exists yet", () => {
		const report = buildContextReport({
			systemPromptChars: 0,
			tools: [],
			lastUsage: undefined,
			contextWindow: 8192,
			reserveTokens: 16384,
		});
		expect(report.conversationTokens).toBeNull();
		expect(report.remainingTokens).toBeNull();
		expect(report.compactionTrigger).toBe(0);
		const conversation = report.rows.find((row) => row.label === "conversation");
		expect(conversation?.precision).toBe("est");
		expect(formatContextReport(report)).toContain("est = chars/4 heuristic");
	});
});

describe("isLocalProvider", () => {
	it("matches hummin fleet provider names, case-insensitive", () => {
		expect(isLocalProvider("hummin")).toBe(true);
		expect(isLocalProvider("Hummin-Local")).toBe(true);
		expect(isLocalProvider("colibri")).toBe(true);
		expect(isLocalProvider("llamacpp")).toBe(true);
		expect(isLocalProvider("ollama")).toBe(true);
		expect(isLocalProvider("zai")).toBe(false);
		expect(isLocalProvider("anthropic")).toBe(false);
	});
});

describe("messageCost", () => {
	it("computes dollars from $/M rates across all buckets", () => {
		const cost = messageCost(
			{
				provider: "zai",
				model: "glm",
				usage: usage({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 }),
			},
			models,
		);
		// 1*1 + 0.5*2 + 2*0.1 = 2.2
		expect(cost).toBeCloseTo(2.2);
	});

	it("prefers provider-reported per-message cost when present", () => {
		const cost = messageCost(
			{
				provider: "x",
				model: "y",
				usage: usage({
					input: 1000,
					output: 1000,
					cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				}),
			},
			models,
		);
		expect(cost).toBe(2);
	});

	it("returns 0 when pricing is unknown", () => {
		expect(messageCost({ provider: "nope", model: "m", usage: usage({ input: 1000 }) }, models)).toBe(0);
	});
});

describe("buildCostReport", () => {
	it("splits totals local ($0) vs cloud across model switches", () => {
		const report = buildCostReport(
			[
				{ provider: "hummin", model: "qwen-local", usage: usage({ input: 900, cacheRead: 90_000, output: 500 }) },
				{ provider: "zai", model: "glm", usage: usage({ input: 1_000_000, output: 0 }) },
				{ provider: "zai", model: "glm", usage: usage({ input: 0, output: 500_000 }) },
			],
			models,
		);
		expect(report.rows).toHaveLength(2);
		expect(report.rows[0].local).toBe(true);
		expect(report.rows[0].cost).toBe(0);
		expect(report.rows[0].requests).toBe(1);
		expect(report.rows[1].requests).toBe(2);
		expect(report.cloudTotal).toBeCloseTo(2); // 1 + 1
		expect(report.localTotal).toBe(0);
		expect(report.total).toBeCloseTo(2);
		const text = formatCostReport(report);
		expect(text).toContain("served locally ($0.00)");
		expect(text).toContain("zai/glm");
		expect(text).toContain("local-served models run on the fleet");
	});

	it("groups nothing to one row for a single-model session", () => {
		const report = buildCostReport([{ provider: "anthropic", model: "m", usage: usage({ input: 1000 }) }], undefined);
		expect(report.rows).toHaveLength(1);
		expect(report.cloudTotal).toBe(0); // unknown pricing
		expect(report.total).toBe(0);
	});
});
