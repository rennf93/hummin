import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { default as humminSys1, type Sys1GateDecision, sys1GateCheck } from "../extensions/hummin-sys1.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

// Handler-level coverage for the hummin-sys1 extension: the sys1_decide tool
// execute path, per-turn steering, test-failure triage wiring, gate kill
// switches, and the sys1-gate.log audit trail. Network and env are pinned:
// fetch is stubbed in every test and COLI_API_KEY / HUMMIN_LAYA_URL /
// ENV_AGENT_DIR are stubbed so results never depend on whether the local decision
// service happens to be running (the module reads these env values at call
// time precisely so this pinning is possible).
//
// Module-level state is shared across tests in this file and vitest runs them
// in order; two consequences each test relies on:
// - the first registration warms the checkpoint, so later registrations and
//   steer handlers issue no warm fetch;
// - the first triage attempt consumes the shared 10-minute rate window, so
//   exactly one triage test may reach laya and the next asserts the limit.

interface FakeResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}

interface RecordedCall {
	url: string;
	body: string;
}

const cleanups: string[] = [];
let agentDir: string;

/** The decision-era env names must be cleared so a developer shell exporting
 * e.g. HUMMIN_DECISION_ENGINE cannot flip engine identity or thresholds
 * under this suite's assertions. */
const DECISION_ENV_NAMES = [
	"HUMMIN_DECISION_ENGINE",
	"HUMMIN_DECISION_URL",
	"HUMMIN_DECISION_API_KEY",
	"HUMMIN_DECISION_GATE_THRESHOLD",
	"HUMMIN_DECISION_STEER_THRESHOLD",
	"HUMMIN_DECISION_TRIAGE_THRESHOLD",
];
const savedDecisionEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "hummin-sys1-handlers-"));
	cleanups.push(agentDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("COLI_API_KEY", "test-key");
	vi.stubEnv("HUMMIN_LAYA_URL", "http://laya.test/v1/systemone");
	vi.stubEnv("HUMMIN_NOTIFY", "off");
	for (const name of DECISION_ENV_NAMES) {
		savedDecisionEnv[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(() => {
	for (const [name, value] of Object.entries(savedDecisionEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Minimal ok response with a laya-shaped payload. */
const okResponse = (payload: unknown): FakeResponse => ({
	ok: true,
	status: 200,
	json: async () => payload,
	text: async () => JSON.stringify(payload),
});

/** A laya noul answer payload for one question. */
const noulPayload = (name: string, noul: number): unknown => ({
	answers: { [name]: { type: "noul", noul, answer_confidence: noul, confidence: noul } },
});

/** Stub global fetch, recording {url, body} per call. */
function stubFetch(handler: (call: RecordedCall) => Promise<unknown> | unknown): RecordedCall[] {
	const calls: RecordedCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown, init?: { body?: string }) => {
			const call = { url: String(url), body: init?.body ?? "" };
			calls.push(call);
			return (await handler(call)) as unknown;
		}),
	);
	return calls;
}

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details: unknown }>;
}

interface FakePi {
	tools: Map<string, RegisteredTool>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	sent: Array<{ customType: string; content: string; display: boolean }>;
	api: ExtensionAPI;
}

/** Capture registerTool / on / sendMessage without touching a real session. */
function fakePi(): FakePi {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sent: FakePi["sent"] = [];
	const api = {
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }) => {
			sent.push(message);
			return Promise.resolve();
		},
	} as unknown as ExtensionAPI;
	return { tools, handlers, sent, api };
}

/** Register the extension against a fake pi. Must run after stubFetch so the
 * one-time startup warm cannot hit the network. */
function register(): FakePi {
	const pi = fakePi();
	humminSys1(pi.api);
	return pi;
}

/** The one and only sys1_decide tool definition. */
function decideTool(pi: FakePi): RegisteredTool {
	const tool = pi.tools.get("sys1_decide");
	if (!tool) throw new Error("sys1_decide was not registered");
	return tool;
}

async function auditLines(): Promise<Array<Record<string, unknown>>> {
	const path = join(agentDir, "sys1-gate.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --- Registration and startup warm -------------------------------------------

test("registration primes the active engine with a warmup read", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("warmup", 0.5)));
	register();
	await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
	const body = JSON.parse(calls[0]?.body ?? "{}") as { state: string; questions: Record<string, { type: string }> };
	expect(body.state).toBe("warmup");
	expect(body.questions.warmup?.type).toBe("noul");
	expect(calls[0]?.url).toBe("http://laya.test/v1/systemone");
});

// --- sys1_decide input validation --------------------------------------------

test("a missing API key does not fail fast: no-auth engines answer, 401 surfaces auth", async () => {
	// No-auth engines (the Mac MLX clef instance) must work with zero config,
	// so an empty key goes through and a success response is honored.
	const calls = stubFetch(() => okResponse(noulPayload("q", 0.5)));
	vi.stubEnv("COLI_API_KEY", "");
	const pi = register();
	const ok = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(ok.isError).toBeUndefined();
	expect(calls).toHaveLength(1);
	// An auth-requiring engine answers 401 and the error points at the key.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" })),
	);
	const denied = await decideTool(pi).execute("t2", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(denied.isError).toBe(true);
	expect(denied.content[0]?.text).toContain("no API key is configured");
});

test("an unconfigured engine fails the tool with a configure hint", async () => {
	stubFetch(() => okResponse(noulPayload("q", 0.5)));
	vi.stubEnv("HUMMIN_DECISION_ENGINE", "jev");
	vi.stubEnv("HUMMIN_DECISION_URL", "");
	vi.stubEnv("HUMMIN_LAYA_URL", "");
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("no url configured");
	expect(result.content[0]?.text).toContain("decision.jev.url");
});

test("empty state and empty questions are rejected before any fetch", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("q", 0.5)));
	const pi = register();
	const emptyState = await decideTool(pi).execute("t1", {
		state: "   ",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(emptyState.isError).toBe(true);
	expect(emptyState.content[0]?.text).toContain("empty state");
	const noQuestions = await decideTool(pi).execute("t2", { state: "state", questions: [] });
	expect(noQuestions.isError).toBe(true);
	expect(noQuestions.content[0]?.text).toContain("no questions");
	expect(calls).toHaveLength(0);
});

test("invalid question names are rejected with the naming rule", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("q", 0.5)));
	const pi = register();
	for (const name of ["has space", "dot.name", "", "x".repeat(65)]) {
		const result = await decideTool(pi).execute("t1", {
			state: "s",
			questions: [{ name, type: "noul", instructions: "i" }],
		});
		expect(result.isError, name).toBe(true);
		expect(result.content[0]?.text).toContain("must be snake_case");
	}
	expect(calls).toHaveLength(0);
});

// --- sys1_decide transport failures ------------------------------------------

test("timeout after the retry is reported as a cold-checkpoint hint", async () => {
	stubFetch(() => {
		throw new Error("The operation was aborted due to timeout");
	});
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("the laya engine did not answer within 15s");
	expect(result.content[0]?.text).toContain("cold checkpoint");
});

test("transport errors name the configured laya URL", async () => {
	stubFetch(() => {
		throw new Error("fetch failed");
	});
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("the laya engine is unreachable at http://laya.test/v1/systemone");
});

test("HTTP error status is surfaced with its detail body", async () => {
	stubFetch(() => ({ ok: false, status: 503, json: async () => ({}), text: async () => "checkpoint loading" }));
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toBe("the laya engine returned HTTP 503: checkpoint loading");
});

test("an abort mid-flight is retried once before succeeding", async () => {
	let attempts = 0;
	const calls = stubFetch(() => {
		attempts++;
		if (attempts === 1) throw new Error("This operation was aborted");
		return okResponse(noulPayload("q", 0.5));
	});
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(result.isError).toBeUndefined();
	expect(calls).toHaveLength(2);
	expect(result.content[0]?.text).toContain("lean yes");
});

// --- sys1_decide answer formatting -------------------------------------------

test("choice answers list the top pick then descending probabilities", async () => {
	stubFetch(() =>
		okResponse({
			answers: {
				plan: { type: "choice", choice: "b", answer_confidence: 0.61, probabilities: { a: 0.3, b: 0.61, c: 0.09 } },
			},
		}),
	);
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "plan", type: "choice", instructions: "i", criteria: ["a", "b", "c"] }],
	});
	expect(result.content[0]?.text).toBe("plan: b (61%; then a 30%, c 9%)");
});

test("score answers resolve the nearest rubric level and top mass", async () => {
	stubFetch(() =>
		okResponse({
			answers: {
				ready: {
					type: "score",
					score: 2.6,
					answer_confidence: 0.7,
					probabilities: { "0": 0.05, "1": 0.1, "2": 0.2, "3": 0.65 },
				},
			},
		}),
	);
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "ready", type: "score", instructions: "i", criteria: ["blocked", "mixed", "ready", "done"] }],
	});
	// 2.6 rounds to level 3 ("done"); "of 3" reflects the criteria length - 1.
	expect(result.content[0]?.text).toContain('ready: 2.60 of 3 ("done"), top mass 65%');
});

test("noul answers state P(true), the lean, and the sure mass", async () => {
	stubFetch(() => okResponse(noulPayload("safe", 0.23)));
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "safe", type: "noul", instructions: "i" }],
	});
	expect(result.content[0]?.text).toContain("safe: P(true) 0.230 -> lean no (77% sure)");
});

test("missing answers and routing are rendered per line", async () => {
	stubFetch(() =>
		okResponse({
			answers: { present: { type: "noul", noul: 0.9, answer_confidence: 0.9, confidence: 0.9 } },
			routing: { model: "english" },
		}),
	);
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [
			{ name: "present", type: "noul", instructions: "i" },
			{ name: "absent", type: "noul", instructions: "i" },
		],
	});
	const lines = result.content[0]?.text.split("\n") ?? [];
	expect(lines[0]).toContain("present: P(true) 0.900 -> lean yes");
	expect(lines[1]).toBe("absent: (no answer returned)");
	expect(lines).toContain("(sys1 engine laya: english)");
});

test("a weakest confidence below 0.5 adds the trust-the-model note", async () => {
	stubFetch(() =>
		okResponse({
			answers: {
				a: { type: "choice", choice: "x", answer_confidence: 0.44, probabilities: { x: 0.44, y: 0.56 } },
				b: { type: "noul", noul: 0.2, answer_confidence: 0.8, confidence: 0.8 },
			},
		}),
	);
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [
			{ name: "a", type: "choice", instructions: "i" },
			{ name: "b", type: "noul", instructions: "i" },
		],
	});
	expect(result.content[0]?.text).toContain("note: weakest answer confidence 44% is below 50%");
});

test("state is truncated to 50k chars and the weakest confidence is audited", async () => {
	const calls = stubFetch(() =>
		okResponse({ answers: { q: { type: "noul", noul: 0.8, answer_confidence: 0.8, confidence: 0.8 } } }),
	);
	const pi = register();
	await decideTool(pi).execute("t1", {
		state: "x".repeat(60_000),
		questions: [{ name: "q", type: "noul", instructions: "i" }],
	});
	expect(calls).toHaveLength(1);
	const body = JSON.parse(calls[0]?.body ?? "{}") as { state: string };
	expect(body.state).toHaveLength(50_000);
	const lines = await auditLines();
	expect(lines.at(-1)).toMatchObject({ type: "read", kind: "decide", p: 0.8 });
});

test("clef-shaped noul answers audit via the sure-mass fallback and name the served model", async () => {
	// Found by live probing 2026-10: the Mac MLX clef instance serves noul
	// answers as {type, noul} with NO confidence field, and the served model at
	// the top level instead of routing.model. Before the fallback, noul-only
	// decide reads on clef audited nothing; the attribution line never rendered.
	stubFetch(() =>
		okResponse({
			model: "clef-flash-4bit",
			answers: { risky: { type: "noul", noul: 0.2 } },
		}),
	);
	const pi = register();
	const result = await decideTool(pi).execute("t1", {
		state: "s",
		questions: [{ name: "risky", type: "noul", instructions: "i" }],
	});
	expect(result.content[0]?.text).toContain("risky: P(true) 0.200 -> lean no (80% sure)");
	expect(result.content[0]?.text).toContain("(sys1 engine laya: clef-flash-4bit)");
	const lines = await auditLines();
	expect(lines.at(-1)).toMatchObject({ type: "read", kind: "decide", p: 0.8 });
});

// --- Per-turn steering ---------------------------------------------------------

const steerEvent = (prompt: string) => ({
	type: "before_agent_start",
	prompt,
	systemPrompt: "",
	systemPromptOptions: {},
});

test("steer skips short or slash prompts without consulting laya", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("destructive_intent", 0.99)));
	const pi = register();
	const handler = pi.handlers.get("before_agent_start")?.[0];
	expect(handler).toBeDefined();
	await handler?.(steerEvent("rm -rf x"), {});
	await handler?.(steerEvent("/compact everything now please"), {});
	expect(calls).toHaveLength(0);
});

test("a confident destructive read injects a hidden steer message", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("destructive_intent", 0.86)));
	const pi = register();
	const handler = pi.handlers.get("before_agent_start")?.[0];
	const result = (await handler?.(
		steerEvent("delete the database volumes and drop the tables for the old tenant"),
		{},
	)) as { message?: { customType: string; content: string; display: boolean } };
	expect(calls).toHaveLength(1);
	expect(result.message?.customType).toBe("sys1-read");
	expect(result.message?.display).toBe(false);
	expect(result.message?.content).toContain("P=0.86");
	const lines = await auditLines();
	expect(lines.at(-1)).toMatchObject({ type: "read", kind: "steer", p: 0.86 });
});

test("a below-threshold or missing read leaves the turn untouched", async () => {
	stubFetch(() => okResponse(noulPayload("destructive_intent", 0.3)));
	const pi = register();
	const handler = pi.handlers.get("before_agent_start")?.[0];
	const prompt = "please rename the exported helper functions across the package";
	expect(await handler?.(steerEvent(prompt), {})).toBeUndefined();
	// Fail open: an unreachable laya must not throw or inject anything.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("fetch failed");
		}),
	);
	expect(await handler?.(steerEvent(prompt), {})).toBeUndefined();
});

test("HUMMIN_LAYA_STEER=off registers no steering hook", () => {
	vi.stubEnv("HUMMIN_LAYA_STEER", "off");
	stubFetch(() => okResponse(noulPayload("warmup", 0.5)));
	const pi = register();
	expect(pi.handlers.has("before_agent_start")).toBe(false);
});

// --- Test-failure triage ---------------------------------------------------------

const triageEvent = (command: string, output: string) => ({
	type: "tool_result",
	toolCallId: "tr1",
	toolName: "bash",
	input: { command },
	content: [{ type: "text", text: output }],
	isError: true,
	details: undefined,
});

test("a failing run scored below 0.45 sends the hidden triage advisory", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("caused_by_change", 0.17)));
	const pi = register();
	const handler = pi.handlers.get("tool_result")?.[0];
	await handler?.(triageEvent("node --test test/foo.test.ts", "FAIL 1 failed | 9 passed"), {});
	expect(calls).toHaveLength(1);
	expect(pi.sent).toHaveLength(1);
	expect(pi.sent[0]?.customType).toBe("hummin-sys1-triage");
	expect(pi.sent[0]?.content).toContain("P(caused_by_change)=0.17");
	expect(pi.sent[0]?.display).toBe(false);
	const lines = await auditLines();
	expect(lines.at(-1)).toMatchObject({ type: "read", kind: "triage", p: 0.17 });
});

test("the triage read is rate limited to one attempt per window", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("caused_by_change", 0.17)));
	const pi = register();
	const handler = pi.handlers.get("tool_result")?.[0];
	// The previous test consumed the shared 10-minute window; this attempt must
	// be skipped entirely (no fetch, no message) despite looking actionable.
	await handler?.(triageEvent("npm test", "Tests: 2 failed, 3 passed"), {});
	expect(calls).toHaveLength(0);
	expect(pi.sent).toHaveLength(0);
});

test("non-bash results, passing runs, and non-test commands never reach laya", async () => {
	const calls = stubFetch(() => okResponse(noulPayload("caused_by_change", 0.17)));
	const pi = register();
	const handler = pi.handlers.get("tool_result")?.[0];
	await handler?.({ ...triageEvent("npm test", "FAIL"), toolName: "edit" }, {});
	await handler?.(triageEvent("ls -la", "FAIL 1 failed"), {});
	await handler?.(triageEvent("npm test", "Tests  5 passed (5)"), {});
	expect(calls).toHaveLength(0);
	expect(pi.sent).toHaveLength(0);
});

test("a throwing handler never propagates into the tool result path", async () => {
	stubFetch(() => {
		throw new Error("connection reset");
	});
	const pi = register();
	const handler = pi.handlers.get("tool_result")?.[0];
	await expect(
		handler?.(triageEvent("node --test test/foo.test.ts", "not ok 1 - crashes"), {}),
	).resolves.toBeUndefined();
});

test("HUMMIN_LAYA_TRIAGE=off registers no triage hook", () => {
	vi.stubEnv("HUMMIN_LAYA_TRIAGE", "off");
	stubFetch(() => okResponse(noulPayload("warmup", 0.5)));
	const pi = register();
	expect(pi.handlers.has("tool_result")).toBe(false);
});

// --- Gate kill switch and audit trail ---------------------------------------------

test("HUMMIN_LAYA_GATE=off disables the gate entirely", async () => {
	vi.stubEnv("HUMMIN_LAYA_GATE", "off");
	let reads = 0;
	const decision: Sys1GateDecision | undefined = await sys1GateCheck("git reset --hard", async () => {
		reads++;
		return { noul: 0.99 };
	});
	expect(decision).toBeUndefined();
	expect(reads).toBe(0);
});

test("scored and rule blocks leave matching audit entries", async () => {
	let reads = 0;
	// Deterministic rule block: no laya read, the audit line carries the rule.
	await sys1GateCheck("git reset --hard", async () => {
		reads++;
		return { noul: 0.5 };
	});
	// Gray-zone block: one laya read, audited, and the block carries the score.
	await sys1GateCheck("deploy-tool --env prod", async () => {
		reads++;
		return { noul: 0.91 };
	});
	expect(reads).toBe(1);
	const lines = await auditLines();
	const ruleBlock = lines.find((line) => line.type === "block" && line.command === "git reset --hard");
	expect(ruleBlock).toMatchObject({ rule: "git reset --hard" });
	expect(ruleBlock?.p).toBeUndefined();
	const scored = lines.find((line) => line.type === "block" && line.command === "deploy-tool --env prod");
	expect(scored).toMatchObject({ p: 0.91 });
	expect(lines.filter((line) => line.type === "read" && line.kind === "gate")).toHaveLength(1);
	// Every gate line names the answering engine so /friction can calibrate
	// per engine.
	expect(lines.every((line) => line.engine === "laya")).toBe(true);
});

test("the repeat escalation asks for ask_user on the second block", async () => {
	const high = async (): Promise<{ noul: number } | null> => ({ noul: 0.93 });
	const cmd = "deploy-tool --nuke-prod-cache";
	const first = await sys1GateCheck(cmd, high);
	const repeat = await sys1GateCheck(cmd, high);
	expect(first?.block).toBe(true);
	expect(first?.reason).not.toContain("already blocked once");
	expect(repeat?.block).toBe(true);
	expect(repeat?.reason).toContain("already blocked once");
	expect(repeat?.reason).toContain("ask_user");
});

// --- Test-runner fast path ---------------------------------------------------
//
// The rubric scores test/build/check scripts LOW, but live probing (2026-09)
// showed laya scoring plain `./test.sh` at P=0.83 - above the block line - so
// they fast-pass deterministically via the same matcher the triage uses.

test("test-runner commands fast-pass without a laya read", async () => {
	let reads = 0;
	const unreachable = async (): Promise<{ noul: number } | null> => {
		reads++;
		return { noul: 0.99 };
	};
	for (const cmd of [
		"./test.sh",
		"./test.sh --filter laya",
		"npm test",
		"npm run test",
		"npx vitest run test/x.test.ts",
		"node --test test/x.test.ts",
		"cargo test --lib",
		"python -m pytest tests/",
	]) {
		await expect(sys1GateCheck(cmd, unreachable), cmd).resolves.toBeUndefined();
	}
	expect(reads).toBe(0);
	// A test run in a chain does not whiten the rest of the chain.
	const decision = await sys1GateCheck("npm test && deploy-tool --env prod", unreachable);
	expect(decision?.block).toBe(true);
});

// --- Write-redirect fast-path regression -------------------------------------------
//
// splitSegments strips redirects from segments, so the whole-command read-only
// fast path used to wave `echo x > important.txt` through before the redirect
// downgrade could send it to laya (found by live probing, 2026-09).

test("write redirects behind read-only commands still reach laya", async () => {
	let reads = 0;
	const high = async (): Promise<{ noul: number } | null> => {
		reads++;
		return { noul: 0.99 };
	};
	for (const cmd of [
		"echo reset > production.yaml",
		"echo data >> notes.md",
		"cat /etc/hosts > /tmp/copy.txt",
		"git diff > patch.diff",
		"npm run check > build.log",
	]) {
		const decision = await sys1GateCheck(cmd, high);
		expect(decision?.block, cmd).toBe(true);
	}
	expect(reads).toBe(5);
});

test("fd dups and /dev/null redirects keep the read-only fast path", async () => {
	let reads = 0;
	const unreachable = async (): Promise<{ noul: number } | null> => {
		reads++;
		return { noul: 0.99 };
	};
	await expect(sys1GateCheck("echo keep 2>&1 | tail -1", unreachable)).resolves.toBeUndefined();
	await expect(sys1GateCheck("echo hi 2>/dev/null", unreachable)).resolves.toBeUndefined();
	// Single-flag curl is allowlisted; -sS is not (the trailing \b in
	// READ_ONLY_BASH fails after a second flag char), so it would be gray zone.
	await expect(sys1GateCheck("curl -s https://x >/dev/null", unreachable)).resolves.toBeUndefined();
	expect(reads).toBe(0);
});
