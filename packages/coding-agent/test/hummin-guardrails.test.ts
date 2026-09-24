import { describe, expect, it } from "vitest";
import {
	defaultPolicy,
	denialKind,
	GuardrailsState,
	hashToolCall,
	SOFT_PING_AT,
} from "../extensions/hummin-guardrails.ts";

function fixedClock(start = 1_000_000) {
	let now = start;
	return () => {
		now += 1;
		return now;
	};
}

describe("defaultPolicy", () => {
	it("disables the tool-call budget by default", () => {
		const policy = defaultPolicy({});
		expect(policy.toolCallWarnAt).toBe(0);
		expect(policy.toolCallHaltAt).toBe(0);
		expect(policy.loopThreshold).toBe(3);
		expect(policy.loopWindow).toBe(10);
		expect(policy.exemptVerbs).toContain("read");
	});

	it("honors env overrides", () => {
		const policy = defaultPolicy({
			HUMMIN_BUDGET_TOOL_CALL_HALT_AT: "12",
			HUMMIN_BUDGET_TOOL_CALL_WARN_AT: "6",
			HUMMIN_BUDGET_LOOP_THRESHOLD: "2",
		});
		expect(policy.toolCallHaltAt).toBe(12);
		expect(policy.toolCallWarnAt).toBe(6);
		expect(policy.loopThreshold).toBe(2);
	});

	it("ignores invalid overrides", () => {
		const policy = defaultPolicy({ HUMMIN_BUDGET_TOOL_CALL_HALT_AT: "nope", HUMMIN_BUDGET_TOOL_CALL_WARN_AT: "-5" });
		expect(policy.toolCallHaltAt).toBe(0);
		expect(policy.toolCallWarnAt).toBe(0);
	});
});

describe("hashToolCall", () => {
	it("is order-insensitive for object keys", () => {
		expect(hashToolCall("bash", { command: "ls", a: 1 })).toBe(hashToolCall("bash", { a: 1, command: "ls" }));
	});

	it("distinguishes different inputs", () => {
		expect(hashToolCall("bash", { command: "ls" })).not.toBe(hashToolCall("bash", { command: "pwd" }));
	});
});

describe("GuardrailsState budget", () => {
	it("never warns or halts with the default (disabled) policy, but fires the soft ping once", () => {
		const state = new GuardrailsState(defaultPolicy({}), fixedClock());
		const results: (string | undefined)[] = [];
		for (let i = 0; i < 400; i++) {
			expect(state.observeCall("bash", { command: `cmd-${i}` }).allowed).toBe(true);
			results.push(state.observeResult("bash", false));
		}
		expect(state.halted).toBe(false);
		const pings = results.filter((text) => text !== undefined);
		expect(pings).toHaveLength(1);
		expect(pings[0]).toContain(`${SOFT_PING_AT} tool calls`);
	});

	it("warns in-band once the warning threshold is crossed", () => {
		const state = new GuardrailsState({ ...defaultPolicy({}), toolCallWarnAt: 2, toolCallHaltAt: 4 }, fixedClock());
		state.observeCall("bash", { command: "a" });
		expect(state.observeResult("bash", false)).toBeUndefined();
		state.observeCall("bash", { command: "b" });
		expect(state.observeResult("bash", false)).toContain("2/4");
	});

	it("halts and denies after the hard limit", () => {
		const state = new GuardrailsState({ ...defaultPolicy({}), toolCallWarnAt: 1, toolCallHaltAt: 2 }, fixedClock());
		for (let i = 0; i < 2; i++) {
			expect(state.observeCall("bash", { command: `cmd-${i}` }).allowed).toBe(true);
			state.observeResult("bash", false);
		}
		const decision = state.observeCall("bash", { command: "cmd-3" });
		expect(decision.allowed).toBe(false);
		expect(state.halted).toBe(true);
		expect(decision.allowed ? "" : decision.reason).toContain("halt");
	});
});

describe("soft ping", () => {
	function runCalls(state: GuardrailsState, count: number): void {
		for (let i = 0; i < count; i++) {
			state.observeCall("bash", { command: `cmd-${i}` });
			state.observeResult("bash", false);
		}
	}

	it("fires exactly once at SOFT_PING_AT calls and never again", () => {
		const state = new GuardrailsState(defaultPolicy({}), fixedClock());
		runCalls(state, SOFT_PING_AT - 1);
		expect(state.observeResult("bash", false)).toBeUndefined();
		state.observeCall("bash", { command: "trigger" });
		expect(state.observeResult("bash", false)).toContain(`${SOFT_PING_AT} tool calls`);
		state.observeCall("bash", { command: "more" });
		expect(state.observeResult("bash", false)).toBeUndefined();
	});

	it("does not fire on error results but fires on the next success", () => {
		const state = new GuardrailsState(defaultPolicy({}), fixedClock());
		for (let i = 0; i < SOFT_PING_AT; i++) {
			state.observeCall("bash", { command: `cmd-${i}` });
		}
		expect(state.observeResult("bash", true)).toBeUndefined();
		expect(state.observeResult("bash", false)).toContain("tool calls");
	});

	it("takes precedence over the budget warn exactly once, then the warn resumes", () => {
		const state = new GuardrailsState({ ...defaultPolicy({}), toolCallWarnAt: 10 }, fixedClock());
		runCalls(state, SOFT_PING_AT);
		state.observeCall("bash", { command: "more" });
		expect(state.observeResult("bash", false)).toContain("[Budget]");
	});
});

describe("denialKind", () => {
	it("maps denial reasons to friction kinds", () => {
		expect(denialKind("[Loop] identical bash call x3 in the last 10 calls")).toBe("loop_detected");
		expect(denialKind("[Circuit] bash has failed 8 time(s)")).toBe("circuit_breaker");
		expect(denialKind("[Budget] 11/10 tool calls - halt.")).toBe("tool_rejected");
	});
});

describe("GuardrailsState loop detection", () => {
	function makeState(overrides: Partial<ReturnType<typeof defaultPolicy>> = {}) {
		return new GuardrailsState({ ...defaultPolicy({}), ...overrides }, fixedClock());
	}

	it("denies the third identical call inside the window", () => {
		const state = makeState();
		for (let i = 0; i < 2; i++) {
			expect(state.observeCall("bash", { command: "make" }).allowed).toBe(true);
			state.observeResult("bash", false);
		}
		const decision = state.observeCall("bash", { command: "make" });
		expect(decision.allowed).toBe(false);
		expect(decision.allowed ? "" : decision.reason).toContain("[Loop]");
	});

	it("allows the same call again once the window moved past it", () => {
		const state = makeState({ loopWindow: 3 });
		for (let i = 0; i < 2; i++) {
			expect(state.observeCall("bash", { command: "make" }).allowed).toBe(true);
			state.observeResult("bash", false);
			// non-exempt filler pushes the window past the earlier identical call
			expect(state.observeCall("edit", { path: `/f-${i}.ts` }).allowed).toBe(true);
			state.observeResult("edit", false);
		}
		expect(state.observeCall("bash", { command: "make" }).allowed).toBe(true);
	});

	it("never loop-denies exempt verbs", () => {
		const state = makeState({ loopThreshold: 2 });
		for (let i = 0; i < 5; i++) {
			expect(state.observeCall("read", { path: "/same.ts" }).allowed).toBe(true);
			state.observeResult("read", false);
		}
	});

	it("counts denied calls against the budget but not the loop window", () => {
		const state = makeState();
		for (let i = 0; i < 2; i++) {
			state.observeCall("bash", { command: "make" });
			state.observeResult("bash", false);
		}
		state.observeCall("bash", { command: "make" }); // denied, popped from window
		expect(state.totalToolCalls).toBe(3);
		// a different call still fits the window and passes
		expect(state.observeCall("bash", { command: "other" }).allowed).toBe(true);
	});
});

describe("GuardrailsState circuit breaker", () => {
	it("opens after the per-tool rejection limit inside the window", () => {
		const policy = { ...defaultPolicy({}), perToolRetryLimit: 3, absoluteRetryMultiplier: 3 };
		const clock = fixedClock();
		const state = new GuardrailsState(policy, clock);
		for (let i = 0; i < 3; i++) {
			expect(state.observeCall("bash", { command: `failing-${i}` }).allowed).toBe(true);
			state.observeResult("bash", true);
		}
		const decision = state.observeCall("bash", { command: "again" });
		expect(decision.allowed).toBe(false);
		expect(decision.allowed ? "" : decision.reason).toContain("[Circuit]");
	});

	it("rejections outside the window do not open the circuit", () => {
		const policy = {
			...defaultPolicy({}),
			perToolRetryLimit: 2,
			perToolRetryWindowMs: 100,
			absoluteRetryMultiplier: 100,
		};
		let now = 1_000_000;
		const state = new GuardrailsState(policy, () => now);
		state.observeCall("bash", { command: "a" });
		state.observeResult("bash", true);
		now += 1_000; // still inside
		state.observeCall("bash", { command: "b" });
		state.observeResult("bash", true);
		now += 5_000; // far outside the 100ms window
		expect(state.observeCall("bash", { command: "c" }).allowed).toBe(true);
	});
});
