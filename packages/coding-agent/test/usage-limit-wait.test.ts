import { describe, expect, test } from "vitest";
import { parseUsageLimitResetAt, planUsageLimitWait } from "../src/core/usage-limit.ts";

const LIVE_OPENROUTER_ERROR =
	"[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-11-17 15:19:15][20261117123031a3a65bb23b6a4eb6]";

describe("usage limit detection", () => {
	test("parses the live openrouter reset time", () => {
		const resetAt = parseUsageLimitResetAt(LIVE_OPENROUTER_ERROR);
		expect(resetAt?.getTime()).toBe(new Date("2026-11-17T15:19:15").getTime());
	});

	test("parses variants and rejects non-limit errors", () => {
		expect(parseUsageLimitResetAt("Usage limit reached. Resets at 2026-11-18T09:00")?.getTime()).toBe(
			new Date("2026-11-18T09:00").getTime(),
		);
		expect(parseUsageLimitResetAt("usage limit exceeded; resets at 2026-11-18 09:00")?.getTime()).toBe(
			new Date("2026-11-18T09:00").getTime(),
		);
		expect(parseUsageLimitResetAt("connection refused")).toBeUndefined();
		expect(parseUsageLimitResetAt("rate limited without a reset time")).toBeUndefined();
	});
});

describe("usage limit wait plan", () => {
	const now = new Date("2026-11-17T05:00:00");

	test("waits until reset plus buffer when inside the cap", () => {
		const resetAt = new Date("2026-11-17T05:30:00");
		const plan = planUsageLimitWait(resetAt, 360, now);
		expect(plan?.resetAt).toBe(resetAt);
		expect(plan?.waitMs).toBe(30 * 60_000 + 30_000);
	});

	test("declines waits past the cap", () => {
		const resetAt = new Date("2026-11-17T18:00:00");
		expect(planUsageLimitWait(resetAt, 360, now)).toBeUndefined();
	});

	test("declines when the reset already passed", () => {
		expect(planUsageLimitWait(new Date("2026-11-17T04:00:00"), 360, now)).toBeUndefined();
	});

	test("accepts tiny waits at the cap boundary", () => {
		expect(planUsageLimitWait(new Date("2026-11-17T06:00:00"), 360, now)?.waitMs).toBe(60 * 60_000 + 30_000);
	});
});
