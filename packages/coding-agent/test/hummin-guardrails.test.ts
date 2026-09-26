import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminGuardrails, {
	defaultPolicy,
	denialKind,
	FRICTION_STEER_CUSTOM_TYPE,
	frictionSteerMessage,
	GuardrailsState,
	hashToolCall,
	isCodeFile,
	isVerificationCommand,
	SOFT_PING_AT,
	VERIFY_NUDGE_CUSTOM_TYPE,
	VERIFY_NUDGE_MESSAGE,
	VERIFY_NUDGE_SOURCE,
	VerifyNudgeState,
} from "../extensions/hummin-guardrails.ts";
import { parseFrictionLine, SessionFrictionTally } from "../extensions/lib/friction.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

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

describe("isVerificationCommand", () => {
	it("matches the supported verification runners, scripts, and chains", () => {
		expect(isVerificationCommand("npm run check")).toBe(true);
		expect(isVerificationCommand("npm test")).toBe(true);
		expect(isVerificationCommand("npm run test")).toBe(true);
		expect(isVerificationCommand("npx vitest run test/foo.test.ts")).toBe(true);
		expect(
			isVerificationCommand(
				"node $(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js --run test/x.test.ts",
			),
		).toBe(true);
		expect(isVerificationCommand("node --test test/foo.test.ts")).toBe(true);
		expect(isVerificationCommand("node -e 'require(\"./smoke\").run()'")).toBe(true);
		expect(isVerificationCommand("npx tsc --noEmit")).toBe(true);
		expect(isVerificationCommand("python -m pytest tests/")).toBe(true);
		expect(isVerificationCommand("go test ./...")).toBe(true);
		expect(isVerificationCommand("cargo test --lib")).toBe(true);
		expect(isVerificationCommand("cargo check")).toBe(true);
		expect(isVerificationCommand("make build")).toBe(true);
		expect(isVerificationCommand("gradle test")).toBe(true);
		expect(isVerificationCommand("mvn verify")).toBe(true);
		expect(isVerificationCommand("npx jest")).toBe(true);
		expect(isVerificationCommand("npx playwright test")).toBe(true);
		expect(isVerificationCommand("npm test && npm run build")).toBe(true);
	});

	it("rejects non-verification commands", () => {
		expect(isVerificationCommand("ls -la")).toBe(false);
		expect(isVerificationCommand("git status")).toBe(false);
		expect(isVerificationCommand("rm -rf build")).toBe(false);
		expect(isVerificationCommand("cat Makefile")).toBe(false);
		expect(isVerificationCommand("echo tested")).toBe(false);
		expect(isVerificationCommand("")).toBe(false);
	});
});

describe("isCodeFile", () => {
	it("accepts code extensions case-insensitively", () => {
		expect(isCodeFile("src/main.ts")).toBe(true);
		expect(isCodeFile("lib/util.PY")).toBe(true);
		expect(isCodeFile("/abs/path/component.tsx")).toBe(true);
		expect(isCodeFile("scripts/ci.sh")).toBe(true);
	});

	it("rejects docs, data, and extensionless paths", () => {
		expect(isCodeFile("README.md")).toBe(false);
		expect(isCodeFile("package.json")).toBe(false);
		expect(isCodeFile("notes.txt")).toBe(false);
		expect(isCodeFile("dockerfile-noext")).toBe(false);
	});
});

describe("VerifyNudgeState", () => {
	it("is due when a code file was edited and never verified, and claims once", () => {
		const nudge = new VerifyNudgeState();
		expect(nudge.isDue()).toBe(false);
		nudge.observeCall("edit", { path: "src/a.ts" }, 10);
		expect(nudge.isDue()).toBe(true);
		expect(nudge.claimIfDue()).toBe(true);
		expect(nudge.claimIfDue()).toBe(false);
	});

	it("is not due when a verification command ran after the last edit", () => {
		const nudge = new VerifyNudgeState();
		nudge.observeCall("edit", { path: "src/a.ts" }, 10);
		nudge.observeCall("bash", { command: "npm test" }, 20);
		expect(nudge.isDue()).toBe(false);
	});

	it("is due again when code is edited after the verification", () => {
		const nudge = new VerifyNudgeState();
		nudge.observeCall("write", { path: "src/a.ts" }, 10);
		nudge.observeCall("bash", { command: "npm run check" }, 20);
		nudge.observeCall("edit", { path: "src/b.ts" }, 30);
		expect(nudge.isDue()).toBe(true);
	});

	it("ignores non-code edits and non-verification commands", () => {
		const nudge = new VerifyNudgeState();
		nudge.observeCall("edit", { path: "README.md" }, 10);
		nudge.observeCall("bash", { command: "ls -la" }, 11);
		expect(nudge.isDue()).toBe(false);
	});

	it("accepts powershell verification commands and malformed input harmlessly", () => {
		const nudge = new VerifyNudgeState();
		nudge.observeCall("edit", { path: "src/a.ts" }, 10);
		nudge.observeCall("powershell", { command: "npm test" }, 20);
		expect(nudge.isDue()).toBe(false);
		// non-string path/command inputs are ignored without throwing
		nudge.observeCall("edit", { path: 42 }, 30);
		nudge.observeCall("bash", { command: 42 }, 31);
		expect(nudge.isDue()).toBe(false);
	});
});

describe("frictionSteerMessage", () => {
	it("names the source, counts, last failing tool, and remediation", () => {
		const tally = new SessionFrictionTally();
		tally.record("tool_error", "guardrails", "bash");
		tally.record("tool_error", "guardrails", "bash");
		const record = tally.record("tool_rejected", "guardrails", "edit");
		const message = frictionSteerMessage(record);
		expect(message).toContain(`${record.total} tool errors/rejections this session from guardrails`);
		expect(message).toContain("2 tool errors, 1 rejection");
		expect(message).toContain("last: edit");
		expect(message).toContain("re-read the target region");
	});
});

describe("VERIFY_NUDGE_MESSAGE", () => {
	it("states the missing verification explicitly", () => {
		expect(VERIFY_NUDGE_MESSAGE).toContain("no verification command");
	});
});

// --- Extension wiring ---------------------------------------------------------
//
// The factory-level tests below drive the real pi.on handlers with a fake
// ExtensionAPI so the session end-to-end behavior is pinned: the verify nudge
// fires once at agent_end, the settings gate is honored, and the friction
// steer fires once per source. appendFriction and the settings gate read the
// agent dir live, so ENV_AGENT_DIR points at a throwaway directory.

interface SentMessage {
	customType: string;
	content: unknown;
	display: boolean;
	details: unknown;
}

interface SentRecord {
	message: SentMessage;
	options: { deliverAs?: string } | undefined;
}

function fakeGuardrailsPi(): {
	api: ExtensionAPI;
	emit: (event: string, payload?: unknown) => Promise<unknown>;
	sent: SentRecord[];
} {
	const handlers = new Map<string, ((event: unknown) => unknown)[]>();
	const sent: SentRecord[] = [];
	const api = {
		on: (event: string, handler: (event: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		sendMessage: (message: SentMessage, options?: { deliverAs?: string }) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const emit = async (event: string, payload: unknown = {}): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload);
		return result;
	};
	return { api, emit, sent };
}

describe("humminGuardrails wiring", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "hummin-guardrails-wiring-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("HUMMIN_GUARDRAILS", "1");
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("sends the verify nudge once at agent_end and logs a friction advisory", async () => {
		const { api, emit, sent } = fakeGuardrailsPi();
		humminGuardrails(api);
		await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "src/a.ts" } });
		await emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "ls" } });
		await emit("agent_end");
		expect(sent).toHaveLength(1);
		const first = sent[0];
		expect(first?.message.customType).toBe(VERIFY_NUDGE_CUSTOM_TYPE);
		expect(first?.message.display).toBe(false);
		expect(String(first?.message.content)).toContain("no verification command");
		expect(first?.options).toEqual({ deliverAs: "nextTurn" });
		// once per session: a second agent_end does not resend
		await emit("agent_end");
		expect(sent).toHaveLength(1);
		const lines = readFileSync(join(agentDir, "friction.log"), "utf8").trim().split("\n");
		const advisories = lines.map((line) => parseFrictionLine(line)).filter((event) => event?.kind === "advisory");
		expect(advisories.some((event) => event?.source === VERIFY_NUDGE_SOURCE)).toBe(true);
	});

	it("does not nudge when a verification command ran after the last edit", async () => {
		const { api, emit, sent } = fakeGuardrailsPi();
		humminGuardrails(api);
		await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "src/a.ts" } });
		await emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "npm test" } });
		await emit("agent_end");
		expect(sent).toHaveLength(0);
	});

	it("honors the verifyNudge=false setting", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ verifyNudge: false }));
		const { api, emit, sent } = fakeGuardrailsPi();
		humminGuardrails(api);
		await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "src/a.ts" } });
		await emit("agent_end");
		expect(sent).toHaveLength(0);
	});

	it("steers once when one source crosses three session errors", async () => {
		const { api, emit, sent } = fakeGuardrailsPi();
		humminGuardrails(api);
		const errorEvent = {
			type: "tool_result",
			toolCallId: "x",
			toolName: "bash",
			input: { command: "npm test" },
			content: [],
			isError: true,
		};
		await emit("tool_result", errorEvent);
		await emit("tool_result", errorEvent);
		await emit("tool_result", errorEvent);
		expect(sent).toHaveLength(1);
		const first = sent[0];
		expect(first?.message.customType).toBe(FRICTION_STEER_CUSTOM_TYPE);
		expect(first?.message.display).toBe(false);
		expect(String(first?.message.content)).toContain("3 tool errors/rejections this session from guardrails");
		// latched: a fourth error does not re-steer
		await emit("tool_result", errorEvent);
		expect(sent).toHaveLength(1);
		const lines = readFileSync(join(agentDir, "friction.log"), "utf8").trim().split("\n");
		const advisories = lines.map((line) => parseFrictionLine(line)).filter((event) => event?.kind === "advisory");
		expect(advisories.some((event) => event?.source === "friction-steer")).toBe(true);
	});
});
