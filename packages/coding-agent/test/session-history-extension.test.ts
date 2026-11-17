import { describe, expect, test } from "vitest";
import type { ExtensionAPI, SessionStartEvent, ToolDefinition } from "../src/core/extensions/types.ts";
import { createSessionHistoryExtension } from "../src/extensions/session-history/index.ts";

interface StubPi {
	pi: ExtensionAPI;
	registered: ToolDefinition[];
	sets: string[][];
	active(): string[];
	handler(event: SessionStartEvent): void;
}

function stubPi(initial: string[]): StubPi {
	let active = [...initial];
	const registered: ToolDefinition[] = [];
	const sets: string[][] = [];
	const handlers: Record<string, (event: SessionStartEvent) => void> = {};
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			registered.push(definition);
		},
		on: (event: string, handler: (event: SessionStartEvent) => void) => {
			handlers[event] = handler;
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
			sets.push([...names]);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		registered,
		sets,
		active: () => active,
		handler: (event: SessionStartEvent) => handlers.session_start?.(event),
	};
}

describe("session-history extension", () => {
	test("registers the sessions tool as inactive", () => {
		const stub = stubPi(["read", "bash"]);
		createSessionHistoryExtension()(stub.pi);
		expect(stub.registered).toHaveLength(1);
		expect(stub.registered[0].name).toBe("sessions");
		expect(stub.registered[0].defaultActive).toBe(false);
	});

	test("arms on session_start with a predecessor, keeping the existing loadout", () => {
		const stub = stubPi(["read", "bash"]);
		createSessionHistoryExtension()(stub.pi);
		stub.handler({ type: "session_start", reason: "new", previousSessionFile: "/tmp/prev.jsonl" });
		expect(stub.sets).toHaveLength(1);
		expect(stub.active()).toEqual(["read", "bash", "sessions"]);
	});

	test("does not arm without a predecessor and does not duplicate when already active", () => {
		const stub = stubPi(["read", "sessions"]);
		createSessionHistoryExtension()(stub.pi);
		stub.handler({ type: "session_start", reason: "startup" });
		expect(stub.sets).toHaveLength(0);
		stub.handler({ type: "session_start", reason: "resume", previousSessionFile: "/tmp/prev.jsonl" });
		expect(stub.sets).toHaveLength(0);
		expect(stub.active()).toEqual(["read", "sessions"]);
	});
});
