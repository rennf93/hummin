import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createTodoReminderExtension } from "../src/extensions/todo-reminder/index.ts";
import {
	findLatestTodoSnapshot,
	formatTodoReminder,
	MAX_REMINDER_LENGTH,
	MAX_SCAN_ENTRIES,
	REMINDER_THRESHOLD,
	TODO_REMINDER_CUSTOM_TYPE,
} from "../src/extensions/todo-reminder/todos.ts";

interface StubPi {
	pi: ExtensionAPI;
	handlers: Record<string, (event: never, ctx: never) => unknown>;
	registeredTools: string[];
	registeredCommands: string[];
}

function stubPi(): StubPi {
	const handlers: Record<string, (event: never, ctx: never) => unknown> = {};
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			handlers[event] = handler;
		},
		registerTool: (tool: { name: string }) => {
			registeredTools.push(tool.name);
		},
		registerCommand: (name: string) => {
			registeredCommands.push(name);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, registeredTools, registeredCommands };
}

const ctxOf = (entries: SessionEntry[]) =>
	({ cwd: "/tmp/project", sessionManager: { getEntries: () => entries } }) as never;

let entryCounter = 0;

function messageEntry(message: AgentMessage): SessionEntry {
	entryCounter += 1;
	return {
		type: "message",
		id: `e${entryCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

function userEntry(text: string): SessionEntry {
	return messageEntry({ role: "user", content: text, timestamp: Date.now() });
}

function todoResultEntry(todos: unknown): SessionEntry {
	entryCounter += 1;
	return messageEntry({
		role: "toolResult",
		toolCallId: `c${entryCounter}`,
		toolName: "todo",
		content: [{ type: "text", text: "ok" }],
		details: { todos },
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage);
}

type BeforeAgentStartHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type ToolCallHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const beforeAgentStart = (stub: StubPi) => stub.handlers.before_agent_start as BeforeAgentStartHandler;
const toolCall = (stub: StubPi) => stub.handlers.tool_call as ToolCallHandler;

const todoToolCallEvent = { type: "tool_call", toolCallId: "t1", toolName: "todo", input: {} };
const readToolCallEvent = { type: "tool_call", toolCallId: "t2", toolName: "read", input: {} };

/** Run N turns with no list change; returns the result of the last turn. */
async function runTurns(stub: StubPi, entries: SessionEntry[], turns: number): Promise<unknown> {
	let result: unknown;
	for (let i = 0; i < turns; i++) {
		result = await beforeAgentStart(stub)({ type: "before_agent_start", prompt: "go" }, ctxOf(entries));
	}
	return result;
}

const reminderOf = (result: unknown) =>
	result as { message?: { customType?: string; content?: string; display?: boolean } } | undefined;

const sampleTodos = [
	{ content: "Fix the parser bug", status: "in_progress" },
	{ content: "Write tests", status: "pending" },
	{ content: "Update docs", status: "pending" },
	{ content: "Ship it", status: "completed" },
];

describe("todo reminder extension", () => {
	test("registers only lifecycle handlers: no tools, no commands", () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		expect(stub.registeredTools).toEqual([]);
		expect(stub.registeredCommands).toEqual([]);
		expect(Object.keys(stub.handlers).sort()).toEqual(["before_agent_start", "session_start", "tool_call"]);
	});

	test("no reminder before the threshold, fires at 5 turns with correct counts and staleness", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [userEntry("plan it"), todoResultEntry(sampleTodos), userEntry("keep going")];

		const early = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD - 1));
		expect(early).toBeUndefined();

		const fired = reminderOf(
			await beforeAgentStart(stub)({ type: "before_agent_start", prompt: "go" }, ctxOf(entries)),
		);
		const message = fired?.message;
		expect(message?.customType).toBe(TODO_REMINDER_CUSTOM_TYPE);
		expect(message?.display).toBe(false);
		expect(message?.content).toContain("1 in progress, 2 pending");
		expect(message?.content).toContain("- Fix the parser bug (in progress)");
		expect(message?.content).toContain("- Write tests (pending)");
		expect(message?.content).not.toContain("- Update docs (pending)");
		expect(message?.content).toContain(
			`TODO list not updated for ${REMINDER_THRESHOLD} turns - update it now (todo tool) or mark it done.`,
		);
	});

	test("no reminder when every item is completed", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [
			todoResultEntry([
				{ content: "Fix the parser bug", status: "completed" },
				{ content: "Write tests", status: "completed" },
			]),
		];
		const result = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD + 3));
		expect(result).toBeUndefined();
	});

	test("no reminder with no todo list in the session", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [userEntry("hello"), userEntry("still hello")];
		const result = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD + 3));
		expect(result).toBeUndefined();
	});

	test("an emptied todo list counts as no list", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [todoResultEntry([])];
		const result = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD + 3));
		expect(result).toBeUndefined();
	});

	test("the latest todo result wins", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const staleList = [{ content: "Old work", status: "pending" }];
		const freshList = [
			{ content: "New work", status: "in_progress" },
			{ content: "More new work", status: "pending" },
		];
		const entries = [todoResultEntry(staleList), userEntry("turn"), todoResultEntry(freshList)];
		const fired = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD));
		expect(fired?.message?.content).toContain("New work");
		expect(fired?.message?.content).not.toContain("Old work");

		const cleared = [...entries, todoResultEntry([{ content: "New work", status: "completed" }])];
		const quiet = reminderOf(await runTurns(stub, cleared, REMINDER_THRESHOLD));
		expect(quiet).toBeUndefined();
	});

	test("counter resets on a todo tool_call, not on other tool calls", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [todoResultEntry(sampleTodos)];

		// Four turns, a todo call, then four more: still below the threshold.
		await runTurns(stub, entries, REMINDER_THRESHOLD - 1);
		await toolCall(stub)(todoToolCallEvent, ctxOf(entries));
		const beforeThreshold = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD - 1));
		expect(beforeThreshold).toBeUndefined();

		// The fifth turn after the reset fires, and the staleness line counts from the reset.
		const fired = reminderOf(
			await beforeAgentStart(stub)({ type: "before_agent_start", prompt: "go" }, ctxOf(entries)),
		);
		expect(fired?.message?.content).toContain(
			`TODO list not updated for ${REMINDER_THRESHOLD} turns - update it now (todo tool) or mark it done.`,
		);

		// A non-todo tool call does not restart the clock.
		const other = stubPi();
		createTodoReminderExtension()(other.pi);
		await toolCall(other)(readToolCallEvent, ctxOf(entries));
		const notReset = reminderOf(await runTurns(other, entries, REMINDER_THRESHOLD));
		expect(notReset?.message?.content).toBeDefined();
	});

	test("session_start resets the counter", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [todoResultEntry(sampleTodos)];
		await runTurns(stub, entries, REMINDER_THRESHOLD - 1);
		await stub.handlers.session_start?.({ type: "session_start", reason: "resume" } as never, ctxOf(entries));
		const result = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD - 1));
		expect(result).toBeUndefined();
		const fired = reminderOf(
			await beforeAgentStart(stub)({ type: "before_agent_start", prompt: "go" }, ctxOf(entries)),
		);
		expect(fired?.message?.display).toBe(false);
	});

	test("content stays capped at 400 characters with the staleness line intact", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const longTodos = [
			{ content: "z".repeat(300), status: "in_progress" },
			{ content: "y".repeat(300), status: "in_progress" },
			{ content: "x".repeat(300), status: "pending" },
		];
		const entries = [todoResultEntry(longTodos)];
		const fired = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD));
		const content = fired?.message?.content ?? "";
		expect(content.length).toBeLessThanOrEqual(MAX_REMINDER_LENGTH);
		expect(content.endsWith("(todo tool) or mark it done.")).toBe(true);
	});

	test("skips todo results older than the scan window", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const filler = Array.from({ length: MAX_SCAN_ENTRIES }, () => userEntry("filler"));
		const buried = [todoResultEntry(sampleTodos), ...filler];
		const outsideWindow = reminderOf(await runTurns(stub, buried, REMINDER_THRESHOLD));
		expect(outsideWindow).toBeUndefined();

		const withinWindow = [todoResultEntry(sampleTodos), ...filler.slice(0, MAX_SCAN_ENTRIES - 1)];
		const found = reminderOf(await runTurns(stub, withinWindow, REMINDER_THRESHOLD));
		expect(found?.message?.content).toBeDefined();
	});

	test("malformed details payloads never crash and never remind", async () => {
		const stub = stubPi();
		createTodoReminderExtension()(stub.pi);
		const entries = [todoResultEntry({ todos: "not-a-list" }), todoResultEntry(null), todoResultEntry("x")];
		const result = reminderOf(await runTurns(stub, entries, REMINDER_THRESHOLD + 2));
		expect(result).toBeUndefined();
	});
});

describe("todo reminder helpers", () => {
	test("findLatestTodoSnapshot counts statuses from the latest todo result", () => {
		const entries = [userEntry("earlier"), todoResultEntry(sampleTodos), userEntry("later")];
		const snapshot = findLatestTodoSnapshot(entries);
		expect(snapshot?.pending).toBe(2);
		expect(snapshot?.inProgress).toBe(1);
		expect(snapshot?.completed).toBe(1);
		expect(snapshot?.todos).toHaveLength(4);
	});

	test("formatTodoReminder lists in_progress items and only the first pending item", () => {
		const snapshot = findLatestTodoSnapshot([todoResultEntry(sampleTodos)]);
		const content = formatTodoReminder(snapshot!, 7);
		expect(content).toContain("TODO reminder: 1 in progress, 2 pending.");
		expect(content).toContain("- Fix the parser bug (in progress)");
		expect(content).toContain("- Write tests (pending)");
		expect(content).not.toContain("- Update docs (pending)");
		expect(content).toContain("TODO list not updated for 7 turns - update it now (todo tool) or mark it done.");
		expect(content.length).toBeLessThanOrEqual(MAX_REMINDER_LENGTH);
	});
});
