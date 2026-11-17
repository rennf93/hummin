import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI, ToolCallEvent } from "../src/core/extensions/types.ts";
import {
	findEntireSettingsDir,
	hardenBashCommand,
	parseInjectContext,
} from "../src/extensions/entire-companion/forwarder.ts";
import { createEntireCompanionExtension } from "../src/extensions/entire-companion/index.ts";

interface RecordedCommand {
	name: string;
	handler: (args: string, ctx: never) => Promise<void>;
}

interface StubPi {
	pi: ExtensionAPI;
	handlers: Record<string, (event: never, ctx: never) => unknown>;
	commands: Record<string, RecordedCommand>;
	notifies: Array<{ message: string; type?: string }>;
}

function stubPi(execImpl?: () => Promise<{ stdout: string }>): StubPi {
	const handlers: Record<string, (event: never, ctx: never) => unknown> = {};
	const commands: Record<string, RecordedCommand> = {};
	const notifies: Array<{ message: string; type?: string }> = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			handlers[event] = handler;
		},
		registerCommand: (name: string, options: { handler: RecordedCommand["handler"] }) => {
			commands[name] = { name, handler: options.handler };
		},
		exec: execImpl ?? (async () => ({ stdout: "" })),
		ui: {
			notify: (message: string, type?: string) => {
				notifies.push({ message, type });
			},
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, notifies };
}

function enabledProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "entire-companion-"));
	mkdirSync(join(dir, ".entire"), { recursive: true });
	writeFileSync(join(dir, ".entire", "settings.local.json"), JSON.stringify({ enabled: true }));
	return dir;
}

const ctxOf = (cwd: string, sessionFile?: string, notify?: (message: string, type?: string) => void) =>
	({ cwd, sessionManager: { getSessionFile: () => sessionFile }, ui: { notify: notify ?? (() => {}) } }) as never;

describe("entire companion forwarder helpers", () => {
	const cleanup: string[] = [];
	afterEach(() => {
		cleanup.length = 0;
	});

	test("finds .entire settings walking up from cwd", () => {
		const root = enabledProject();
		cleanup.push(root);
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findEntireSettingsDir(nested)).toBe(root);
		expect(findEntireSettingsDir(tmpdir())).toBeUndefined();
	});

	test("parses the inject_context envelope and ignores other lines", () => {
		const stdout = ['{"other":1}', '{"inject_context":"recall text"}', "noise"].join("\n");
		expect(parseInjectContext(stdout)).toBe("recall text");
		expect(parseInjectContext("")).toBeNull();
		expect(parseInjectContext("plain text")).toBeNull();
	});

	test("bash hardening prepends once and respects existing pins", () => {
		expect(hardenBashCommand("git push")).toBe("export GIT_TERMINAL_PROMPT=0\ngit push");
		expect(hardenBashCommand("GIT_TERMINAL_PROMPT=0 git push")).toBe("GIT_TERMINAL_PROMPT=0 git push");
	});
});

describe("entire companion extension", () => {
	beforeEach(() => {
		// The factory stamps the nested marker into the environment; tests share the process.
		delete process.env.ENTIRE_PI_NESTED;
	});
	afterEach(() => {
		delete process.env.ENTIRE_PI_NESTED;
	});

	test("registers /entire and does not arm without Entire settings", async () => {
		let probeCalls = 0;
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => {
				probeCalls += 1;
				return true;
			},
		})(stub.pi);
		expect(stub.commands.entire).toBeDefined();

		const empty = mkdtempSync(join(tmpdir(), "entire-companion-empty-"));
		await stub.handlers.session_start({ type: "session_start" } as never, ctxOf(empty, "s.jsonl"));
		expect(probeCalls).toBe(0);
		await stub.commands.entire.handler(
			"",
			ctxOf(empty, undefined, (m) => stub.notifies.push({ message: m })),
		);
		expect(stub.notifies[0].message).toContain("not enabled");
	});

	test("arms when enabled: session_start and agent_end forward cwd and session_file", async () => {
		const dir = enabledProject();
		const hooks: Array<{ name: string; payload: Record<string, unknown> }> = [];
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: {
				runHook: async (name, payload) => {
					hooks.push({ name, payload });
					return "";
				},
			},
		})(stub.pi);

		await stub.handlers.session_start({ type: "session_start" } as never, ctxOf(dir, join(dir, "s.jsonl")));
		await stub.handlers.agent_end({ type: "agent_end" } as never, ctxOf(dir, join(dir, "s.jsonl")));
		expect(hooks.map((h) => h.name)).toEqual(["session_start", "agent_end"]);
		expect(hooks[0].payload.session_file).toBe(join(dir, "s.jsonl"));
		expect(hooks[0].payload.cwd).toBe(dir);
	});

	test("before_agent_start forwards the prompt and surfaces inject_context as a hidden message", async () => {
		const dir = enabledProject();
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: {
				runHook: async (_name, payload) => {
					expect(payload.prompt).toBe("fix the bug");
					return '{"inject_context":"brain says hi"}\n';
				},
			},
		})(stub.pi);

		const result = await stub.handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "fix the bug" } as never,
			ctxOf(dir, "s.jsonl"),
		);
		const message = (result as { message?: { customType?: string; display?: boolean; content?: string } }).message;
		expect(message?.customType).toBe("entire-context");
		expect(message?.display).toBe(false);
		expect(message?.content).toBe("brain says hi");
	});

	test("binary probe result is cached across turns", async () => {
		const dir = enabledProject();
		let probeCalls = 0;
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => {
				probeCalls += 1;
				return true;
			},
			hookRunner: { runHook: async () => "" },
		})(stub.pi);
		await stub.handlers.session_start({ type: "session_start" } as never, ctxOf(dir, "s.jsonl"));
		await stub.handlers.session_start({ type: "session_start" } as never, ctxOf(dir, "s.jsonl"));
		expect(probeCalls).toBe(1);
	});

	test("nested launch in an enabled project skips lifecycle forwarding but keeps bash hardening", async () => {
		const dir = enabledProject();
		const prevCwd = process.cwd();
		process.env.ENTIRE_PI_NESTED = "1";
		process.chdir(dir);
		try {
			const stub = stubPi();
			createEntireCompanionExtension({ binaryProbe: async () => true, hookRunner: { runHook: async () => "" } })(
				stub.pi,
			);
			expect(stub.handlers.session_start).toBeUndefined();
			const event = {
				type: "tool_call",
				toolName: "bash",
				input: { command: "git push" },
			} as unknown as ToolCallEvent;
			await (stub.handlers.tool_call as (event: ToolCallEvent, ctx: unknown) => unknown)?.(
				event,
				ctxOf(dir) as never,
			);
			expect((event as unknown as { input: { command: string } }).input.command).toContain("GIT_TERMINAL_PROMPT=0");
		} finally {
			process.chdir(prevCwd);
			delete process.env.ENTIRE_PI_NESTED;
		}
	});

	test("/entire reports the settings dir, entire status, and the data-flow facts", async () => {
		const dir = enabledProject();
		const stub = stubPi(async () => ({ stdout: "Enabled · branch main\nCheckpoints sync to: origin" }));
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: { runHook: async () => "" },
		})(stub.pi);
		await stub.commands.entire.handler(
			"",
			ctxOf(dir, undefined, (m) => stub.notifies.push({ message: m })),
		);
		const message = stub.notifies[0].message;
		expect(message).toContain("armed");
		expect(message).toContain(dir);
		expect(message).toContain("Checkpoints sync to: origin");
		expect(message).toContain("unredacted under .entire/metadata");
	});

	test("/entire survives a failing status exec", async () => {
		const dir = enabledProject();
		const stub = stubPi(async () => {
			throw new Error("hung");
		});
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: { runHook: async () => "" },
		})(stub.pi);
		await stub.commands.entire.handler(
			"",
			ctxOf(dir, undefined, (m) => stub.notifies.push({ message: m })),
		);
		expect(stub.notifies[0].message).toContain("(entire status failed to run)");
	});

	test("armed bash hardening applies outside nested mode, unarmed is a no-op", async () => {
		const dir = enabledProject();
		const empty = mkdtempSync(join(tmpdir(), "entire-companion-plain-"));
		const stub = stubPi();
		createEntireCompanionExtension({ binaryProbe: async () => true, hookRunner: { runHook: async () => "" } })(
			stub.pi,
		);
		const makeEvent = () =>
			({ type: "tool_call", toolName: "bash", input: { command: "git push" } }) as unknown as ToolCallEvent;
		const armedEvent = makeEvent();
		await (stub.handlers.tool_call as (e: ToolCallEvent, c: unknown) => unknown)?.(armedEvent, ctxOf(dir) as never);
		expect((armedEvent as unknown as { input: { command: string } }).input.command).toContain(
			"GIT_TERMINAL_PROMPT=0",
		);
		const unarmedEvent = makeEvent();
		await (stub.handlers.tool_call as (e: ToolCallEvent, c: unknown) => unknown)?.(
			unarmedEvent,
			ctxOf(empty) as never,
		);
		expect((unarmedEvent as unknown as { input: { command: string } }).input.command).toBe("git push");
	});

	test("session_shutdown forwards the type-only payload when armed", async () => {
		const dir = enabledProject();
		const hooks: Array<{ name: string; payload: Record<string, unknown> }> = [];
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: {
				runHook: async (name, payload) => {
					hooks.push({ name, payload });
					return "";
				},
			},
		})(stub.pi);
		await stub.handlers.session_shutdown?.(
			{ type: "session_shutdown", reason: "quit" } as never,
			ctxOf(dir) as never,
		);
		expect(hooks).toEqual([{ name: "session_shutdown", payload: { type: "session_shutdown" } }]);
	});

	test("custom-message runs forward without a prompt key", async () => {
		const dir = enabledProject();
		const payloads: Array<Record<string, unknown>> = [];
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: {
				runHook: async (_name, payload) => {
					payloads.push(payload);
					return "";
				},
			},
		})(stub.pi);
		await stub.handlers.before_agent_start?.(
			{ type: "before_agent_start", messageType: "custom" } as never,
			ctxOf(dir, "s.jsonl") as never,
		);
		expect(payloads[0]).toEqual({ type: "before_agent_start", cwd: dir, session_file: "s.jsonl" });
	});

	test("inject_context is capped at 600 characters", async () => {
		const dir = enabledProject();
		const long = "z".repeat(800);
		const stub = stubPi();
		createEntireCompanionExtension({
			binaryProbe: async () => true,
			hookRunner: { runHook: async () => `{"inject_context":"${long}"}` },
		})(stub.pi);
		const result = await stub.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "p" } as never,
			ctxOf(dir, "s.jsonl") as never,
		);
		const content = (result as { message?: { content?: string } }).message?.content ?? "";
		expect(content.startsWith("z".repeat(600))).toBe(true);
		expect(content.endsWith("[truncated]")).toBe(true);
	});

	test("settings.json (non-local) also arms discovery", () => {
		const dir = mkdtempSync(join(tmpdir(), "entire-companion-settings-"));
		mkdirSync(join(dir, ".entire"), { recursive: true });
		writeFileSync(join(dir, ".entire", "settings.json"), "{}");
		expect(findEntireSettingsDir(dir)).toBe(dir);
	});

	test("egress scope: the companion modules declare no network APIs", async () => {
		const { readFileSync } = await import("node:fs");
		const testDir = new URL(".", import.meta.url).pathname;
		for (const file of ["index.ts", "forwarder.ts"]) {
			const src = readFileSync(join(testDir, "../src/extensions/entire-companion", file), "utf8");
			expect(src).not.toMatch(/fetch\(|node:https?["']|from ["']http/);
		}
	});
});
