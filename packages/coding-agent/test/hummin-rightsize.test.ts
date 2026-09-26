import { afterEach, describe, expect, it, vi } from "vitest";
import humminLaya from "../extensions/hummin-laya.ts";
import {
	buildCatalog,
	decideRightSize,
	type LayScoreCall,
	type ModelLike,
	resolveRequestedModel,
} from "../extensions/lib/model-rightsize.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

vi.hoisted(() => {
	process.env.COLI_API_KEY = "test";
	process.env.HUMMIN_LAYA_RIGHTSIZE = "1";
});

type Handler = (event: any, context?: any) => Promise<unknown> | unknown;

function load() {
	const handlers = new Map<string, Handler[]>();
	const registeredTools: string[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => {
			registeredTools.push(tool.name);
			return undefined;
		},
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => undefined;
		},
	} as unknown as ExtensionAPI;
	humminLaya(pi);
	return {
		registeredTools,
		event: async (name: string, event: any, context?: any) => {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
			return result;
		},
	};
}

const models = [
	{ provider: "zai", id: "glm-5.3-flash", reasoning: false, thinkingLevelMap: { off: "off", low: "low" } },
	{ provider: "zai", id: "glm-5.3", reasoning: true, thinkingLevelMap: { off: "off", low: "low", high: "high" } },
	{ provider: "hummin", id: "qwen3.8-27b", reasoning: false, thinkingLevelMap: { off: "off" } },
];

describe("hummin laya right-size dispatch authority", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("defers child-dispatch gating to the call-site review authority instead of a parallel tool_call gate", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const loaded = load();
		await loaded.event("session_start", {}, { modelRegistry: { getAvailable: () => models } });
		const result = await loaded.event("tool_call", {
			toolName: "task",
			toolCallId: "dispatch-1",
			input: {
				prompt: "debug the race in the concurrent flush architecture",
				model: "zai/glm-5.3-flash",
				thinking: "low",
			},
		});
		// The extension must not gate here: prepareChildDispatch
		// (lib/child-dispatch-review.ts) is the single authority; two gates
		// would issue competing review receipts. (A warmup ping may fire — that
		// is the checkpoint warmer, not a dispatch review — so only a
		// right-size/capability-tier question would be a violation.)
		expect(result).toBeUndefined();
		const bodies = fetchMock.mock.calls.map((call) => String(call[1]?.body ?? ""));
		expect(
			bodies.some((body) => body.includes("recommended_configuration") || body.includes("capability_tier")),
		).toBe(false);
	});

	it("registers the child_dispatch_review tool so the parent can resolve holds", () => {
		const loaded = load();
		expect(loaded.registeredTools).toContain("child_dispatch_review");
	});
});

const FLASH = "glm-5.3-flash";
const PRO = "glm-5.3";
const MAX = "glm-5.3-max";
const runtimeModels: ModelLike[] = [
	{ provider: "zai", id: FLASH, reasoning: true, thinkingLevelMap: { low: "low", high: null } },
	{ provider: "zai", id: PRO, reasoning: true, thinkingLevelMap: { low: "low", high: "high" } },
	{ provider: "zai", id: MAX, reasoning: true, thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh" } },
	{ provider: "hummin", id: "qwen3.8-27b", reasoning: false, thinkingLevelMap: { off: "off" } },
];
const catalog = buildCatalog(runtimeModels, [
	{ provider: "zai", modelId: FLASH, description: "routine fast model", speed: "fast", cost: { input: 1, output: 2 } },
	{ provider: "zai", modelId: PRO, description: "multi-step model", speed: "normal", cost: { input: 3, output: 6 } },
	{
		provider: "zai",
		modelId: MAX,
		description: "deep reasoning model",
		speed: "slow",
		cost: { input: 8, output: 16 },
	},
]);
const enabled = { enabled: true, swingThreshold: 0.6 };
const answer =
	(configuration: string, p: number): LayScoreCall =>
	async () => [{ answer: configuration, p }];
const label = (provider: string, model: string, thinking: string) => `${provider}/${model} [thinking=${thinking}]`;

describe("model right-size catalog and decisions", () => {
	it("catalog contains actual runtime model/thinking configurations and profiles", () => {
		expect(
			catalog.models.some(
				(entry) => label(entry.provider, entry.modelId, entry.thinking) === label("zai", FLASH, "low"),
			),
		).toBe(true);
		expect(catalog.models.some((entry) => entry.modelId === MAX && entry.thinking === "xhigh")).toBe(true);
		expect(resolveRequestedModel(`zai/${PRO}`, catalog).matched).toBe(true);
	});

	it("configured profiles act as an allowlist: unprofiled models are not offered", () => {
		// Regression: laya picked superseded models (e.g. glm-5-turbo) because
		// the catalog offered every registry model. When the user maintains
		// profiles, only profiled models are candidates.
		expect(catalog.models.some((entry) => entry.provider === "hummin")).toBe(false);
	});

	it("without profiles the full registry is offered", () => {
		const full = buildCatalog(runtimeModels, []);
		expect(full.models.some((entry) => entry.provider === "hummin" && entry.thinking === "off")).toBe(true);
		expect(full.models.some((entry) => entry.modelId === MAX && entry.thinking === "xhigh")).toBe(true);
	});

	it("aliases and unresolved defaults do not fabricate registry models", () => {
		expect(resolveRequestedModel("fast", catalog).matched).toBe(false);
		expect(resolveRequestedModel("local", catalog).matched).toBe(false);
		expect(resolveRequestedModel(undefined, catalog).matched).toBe(false);
		expect(resolveRequestedModel("invented-model", catalog).matched).toBe(false);
	});

	it("disabled and empty requests do not consult Laya", async () => {
		let calls = 0;
		const laya: LayScoreCall = async () => {
			calls += 1;
			return [{ answer: "garbage", p: 1 }];
		};
		expect(
			(
				await decideRightSize({
					subtask: "rewrite scheduler",
					requested: FLASH,
					thinking: "low",
					catalog,
					config: { enabled: false, swingThreshold: 0.6 },
					laya,
				})
			).action,
		).toBe("allow");
		expect((await decideRightSize({ subtask: "", requested: FLASH, catalog, config: enabled, laya })).action).toBe(
			"allow",
		);
		expect(calls).toBe(0);
	});

	it("matching selected configuration allows", async () => {
		const result = await decideRightSize({
			subtask: "format this file",
			requested: `zai/${FLASH}`,
			thinking: "low",
			catalog,
			config: enabled,
			laya: answer(label("zai", FLASH, "low"), 0.9),
		});
		expect(result.action).toBe("allow");
		expect(result.consulted).toBe(true);
	});

	it("strong overpowered choice blocks and recommends a cheaper adequate same-provider configuration", async () => {
		const result = await decideRightSize({
			subtask: "format this file",
			requested: `zai/${MAX}`,
			thinking: "xhigh",
			catalog,
			config: enabled,
			laya: answer(label("zai", FLASH, "low"), 0.95),
		});
		expect(result.action).toBe("block");
		expect(result.suggestedModel).toEqual({ provider: "zai", modelId: FLASH, thinking: "low" });
		expect(result.reason ?? "").toMatch(/review|override/i);
	});

	it("strong underpowered choice recommends deeper thinking on same model/provider", async () => {
		const result = await decideRightSize({
			subtask: "debug the race in concurrent flush architecture",
			requested: `zai/${FLASH}`,
			thinking: "low",
			catalog,
			config: enabled,
			laya: answer(label("zai", MAX, "xhigh"), 0.95),
		});
		expect(result.action).toBe("block");
		expect(result.suggestedModel?.provider).toBe("zai");
		expect(result.suggestedModel?.modelId).toBe(MAX);
	});

	it("weak disagreement is advisory", async () => {
		const result = await decideRightSize({
			subtask: "moderate refactor",
			requested: `zai/${PRO}`,
			thinking: "high",
			catalog,
			config: enabled,
			laya: answer(label("zai", FLASH, "low"), 0.55),
		});
		expect(result.action).toBe("advisory");
	});

	it("swings on the selected-vs-requested margin, not absolute confidence", async () => {
		const selected = label("zai", FLASH, "low");
		const requested = label("zai", MAX, "xhigh");
		const distribution: Record<string, number> = { [selected]: 0.4, [requested]: 0.2 };
		const laya: LayScoreCall = async () => [
			{
				answer: selected,
				p: 0.4,
				probabilities: distribution,
			},
		];
		const base = {
			subtask: "format this file",
			requested: `zai/${MAX}`,
			thinking: "xhigh" as const,
			catalog,
			laya,
		};
		// Margin 0.4 - 0.2 = 0.2: advisory at 0.35 even though absolute p is only 0.4.
		expect((await decideRightSize({ ...base, config: { enabled: true, swingThreshold: 0.35 } })).action).toBe(
			"advisory",
		);
		// The same margin blocks a tighter threshold.
		expect((await decideRightSize({ ...base, config: { enabled: true, swingThreshold: 0.15 } })).action).toBe(
			"block",
		);
	});

	it("malformed and unavailable Laya responses fail open", async () => {
		for (const laya of [
			answer("not a listed candidate", 0.99),
			async () => {
				throw new Error("offline");
			},
		]) {
			const result = await decideRightSize({
				subtask: "rewrite scheduler",
				requested: FLASH,
				thinking: "low",
				catalog,
				config: enabled,
				laya,
			});
			expect(result.action).toBe("allow");
		}
	});
});
