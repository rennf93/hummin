import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildHookEnv,
	buildShellCommand,
	capTimeout,
	extractBlockDecision,
	formatHooksTable,
	globToRegExp,
	HOOK_EVENTS,
	HookConfigError,
	hookMatches,
	lastJsonObject,
	parseHooksConfig,
} from "../extensions/hummin-hooks.ts";

describe("capTimeout", () => {
	it("applies the default for missing/invalid values", () => {
		expect(capTimeout(undefined)).toBe(10_000);
		expect(capTimeout(0)).toBe(10_000);
		expect(capTimeout(-5)).toBe(10_000);
		expect(capTimeout("1000")).toBe(10_000);
		expect(capTimeout(Number.NaN)).toBe(10_000);
		expect(capTimeout(Number.POSITIVE_INFINITY)).toBe(10_000);
	});

	it("caps at 60000 and floors fractional values", () => {
		expect(capTimeout(500)).toBe(500);
		expect(capTimeout(1500.9)).toBe(1500);
		expect(capTimeout(60_000)).toBe(60_000);
		expect(capTimeout(600_000)).toBe(60_000);
	});
});

describe("globToRegExp / hookMatches", () => {
	it("anchors the pattern", () => {
		expect(globToRegExp("bash").test("xbash")).toBe(false);
		expect(globToRegExp("bash").test("bashx")).toBe(false);
		expect(globToRegExp("bash").test("bash")).toBe(true);
	});

	it("supports * and ? wildcards", () => {
		expect(globToRegExp("mcp_*").test("mcp_fs_read")).toBe(true);
		expect(globToRegExp("mcp_*").test("browser_fetch")).toBe(false);
		expect(globToRegExp("edit?ile").test("editfile")).toBe(true);
		expect(globToRegExp("edit?ile").test("editXile")).toBe(true);
		expect(globToRegExp("edit?ile").test("editXXile")).toBe(false);
	});

	it("escapes regex metacharacters", () => {
		expect(globToRegExp("a.b").test("aXb")).toBe(false);
		expect(globToRegExp("a.b").test("a.b")).toBe(true);
		expect(globToRegExp("mcp_+(x)").test("mcp_x")).toBe(false);
	});

	it("undefined matcher matches everything", () => {
		expect(hookMatches({ matcher: undefined }, "anything")).toBe(true);
		expect(hookMatches({ matcher: "read" }, "read")).toBe(true);
		expect(hookMatches({ matcher: "read" }, "write")).toBe(false);
	});
});

describe("parseHooksConfig", () => {
	it("returns an empty list for empty hooks or empty document", () => {
		expect(parseHooksConfig("{}", "t")).toEqual([]);
		expect(parseHooksConfig(JSON.stringify({ hooks: {} }), "t")).toEqual([]);
	});

	it("parses valid entries with defaults applied", () => {
		const entries = parseHooksConfig(
			JSON.stringify({
				hooks: {
					tool_call: [{ matcher: "bash", command: "echo hi", timeout_ms: 120000 }],
					agent_end: [{ command: "touch /tmp/x" }],
				},
			}),
			"global",
		);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			event: "tool_call",
			matcher: "bash",
			command: "echo hi",
			timeoutMs: 60_000,
			source: "global",
		});
		expect(entries[1]).toMatchObject({ event: "agent_end", matcher: undefined, timeoutMs: 10_000 });
	});

	it("rejects invalid JSON, bad shapes, unknown events, bad fields", () => {
		expect(() => parseHooksConfig("{nope", "f")).toThrow(HookConfigError);
		expect(() => parseHooksConfig("[]", "f")).toThrow(HookConfigError);
		expect(() => parseHooksConfig(JSON.stringify({ hooks: [] }), "f")).toThrow(HookConfigError);
		expect(() => parseHooksConfig(JSON.stringify({ hooks: { nope: [] } }), "f")).toThrow(/unknown hook event/);
		expect(() => parseHooksConfig(JSON.stringify({ hooks: { tool_call: {} } }), "f")).toThrow(/must be an array/);
		expect(() => parseHooksConfig(JSON.stringify({ hooks: { tool_call: ["x"] } }), "f")).toThrow(/must be an object/);
		expect(() => parseHooksConfig(JSON.stringify({ hooks: { tool_call: [{ command: "" }] } }), "f")).toThrow(
			/command/,
		);
		expect(() => parseHooksConfig(JSON.stringify({ hooks: { tool_call: [{}] } }), "f")).toThrow(/command/);
		expect(() =>
			parseHooksConfig(JSON.stringify({ hooks: { tool_call: [{ command: "x", matcher: 5 }] } }), "f"),
		).toThrow(/matcher/);
		expect(() =>
			parseHooksConfig(JSON.stringify({ hooks: { tool_call: [{ command: "x", timeout_ms: -1 }] } }), "f"),
		).toThrow(/timeout_ms/);
	});

	it("covers all spec events", () => {
		expect([...HOOK_EVENTS]).toEqual(["tool_call", "tool_result", "agent_start", "agent_end"]);
	});
});

describe("block-decision extraction", () => {
	it("finds the last JSON object in noisy output", () => {
		expect(extractBlockDecision('{"block": true, "reason": "no"}')).toEqual({ block: true, reason: "no" });
		expect(extractBlockDecision('log line\nmore {log} data\n{"block": false}')).toEqual({ block: false });
		expect(extractBlockDecision('{"block": true} {"block": false, "reason": "later wins"}')).toEqual({
			block: false,
			reason: "later wins",
		});
	});

	it("handles braces inside strings", () => {
		expect(extractBlockDecision('{"reason": "curly } inside", "block": true}')).toEqual({
			block: true,
			reason: "curly } inside",
		});
	});

	it("ignores non-JSON, empty, and decision-less output", () => {
		expect(extractBlockDecision("")).toBeUndefined();
		expect(extractBlockDecision("plain text output")).toBeUndefined();
		expect(extractBlockDecision("{broken")).toBeUndefined();
		expect(extractBlockDecision('{"reason": "no block key"}')).toBeUndefined();
		expect(extractBlockDecision('{"block": "yes"}')).toBeUndefined();
	});

	it("lastJsonObject skips unparseable spans and finds earlier valid ones", () => {
		expect(lastJsonObject('{bad} {"ok": 1}')).toEqual({ ok: 1 });
		expect(lastJsonObject("no json at all")).toBeUndefined();
	});
});

describe("buildShellCommand", () => {
	it("pipes the event JSON into the user command", () => {
		const command = buildShellCommand("jq .block", '{"event":"tool_call"}');
		expect(command).toBe(`printf '%s' '{"event":"tool_call"}' | (jq .block)`);
	});

	it("escapes single quotes safely", () => {
		const command = buildShellCommand("echo 'it'", '{"r":"it\'s"}');
		expect(command).toContain(`'{"r":"it'\\''s"}'`);
		expect(() => buildShellCommand("true", '{"a":"\nb"}')).not.toThrow();
	});
});

describe("buildHookEnv", () => {
	it("exposes PI_* session variables and disables memory recursion", () => {
		const env = buildHookEnv({
			sessionManager: {
				getSessionId: () => "s1",
				getSessionFile: () => "/tmp/s.jsonl",
			} as unknown as ExtensionContext["sessionManager"],
			model: { provider: "hummin", id: "glm-4.7" } as unknown as ExtensionContext["model"],
			thinkingLevel: "high",
		});
		expect(env).toEqual({
			HUMMIN_MEMORY: "0",
			PI_SESSION_ID: "s1",
			PI_SESSION_FILE: "/tmp/s.jsonl",
			PI_PROVIDER: "hummin",
			PI_MODEL: "glm-4.7",
			PI_REASONING_LEVEL: "high",
		});
	});

	it("omits absent model, session file, and thinking level", () => {
		const env = buildHookEnv({
			sessionManager: {
				getSessionId: () => "s2",
				getSessionFile: () => undefined,
			} as unknown as ExtensionContext["sessionManager"],
			model: undefined,
			thinkingLevel: undefined,
		});
		expect(env).toEqual({ HUMMIN_MEMORY: "0", PI_SESSION_ID: "s2" });
	});
});

describe("formatHooksTable", () => {
	it("shows a pointer line when nothing is loaded", () => {
		expect(formatHooksTable([])).toContain("No hooks loaded");
	});

	it("renders aligned rows with matcher, command, source, timeout", () => {
		const table = formatHooksTable([
			{ event: "tool_call", matcher: "bash", command: "deny rm", timeoutMs: 5000, source: "/g/hooks.json" },
			{
				event: "agent_end",
				matcher: undefined,
				command: "notify",
				timeoutMs: 10_000,
				source: "/p/.hummin/hooks.json",
			},
		]);
		const lines = table.split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("EVENT");
		expect(lines[0]).toContain("MATCHER");
		expect(lines[0]).toContain("SOURCE");
		expect(lines[1]).toMatch(/^-+$/);
		expect(lines[2]).toContain("tool_call");
		expect(lines[2]).toContain("bash");
		expect(lines[2]).toContain("5000ms");
		expect(lines[3]).toContain("*");
		expect(lines[3]).toContain("notify");
		expect(lines[3]).toContain("10000ms");
		const [header, divider, row1, row2] = lines;
		expect(new Set([header!.length, row1!.length, row2!.length]).size).toBe(1);
		expect(divider!.length).toBe(header!.length);
	});
});
