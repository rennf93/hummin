import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { compactToolDescription } from "../src/core/compact-prompt.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { AUTO_COMPACT_CONTEXT_WINDOW } from "../src/core/system-prompt.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const FULL_DOCS_MARKER = "hummin documentation (read only when the user asks about hummin itself";
const COMPACT_DOCS_MARKER = "hummin docs (only if the user asks about hummin itself)";

describe("AgentSession auto compact prompt", () => {
	let tempDir: string;
	let sessions: AgentSession[];
	let previousEnvValue: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auto-compact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessions = [];
		previousEnvValue = process.env.HUMMIN_COMPACT_PROMPT_AUTO;
		delete process.env.HUMMIN_COMPACT_PROMPT_AUTO;
	});

	afterEach(() => {
		for (const session of sessions) session.dispose();
		if (previousEnvValue === undefined) delete process.env.HUMMIN_COMPACT_PROMPT_AUTO;
		else process.env.HUMMIN_COMPACT_PROMPT_AUTO = previousEnvValue;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(model: ReturnType<typeof getModel>, options?: { compactPrompt?: boolean }) {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		if (options?.compactPrompt) settingsManager.setCompactPrompt(true);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		return { session, settingsManager };
	}

	function activeBashDescription(session: AgentSession): string {
		return session.agent.state.tools.find((tool) => tool.name === "bash")!.description;
	}

	function fullBashDescription(session: AgentSession): string {
		return session.getAllTools().find((tool) => tool.name === "bash")!.description;
	}

	function sectionedSystemMessages(session: AgentSession): Array<Record<string, string | null>> {
		return session.messages
			.filter((message): message is Extract<typeof message, { role: "system" }> => message.role === "system")
			.map((message) => message.sections)
			.filter((sections): sections is Record<string, string | null> => sections !== undefined);
	}

	it("auto-compacts the prompt and tools for a model at the context window threshold", async () => {
		const largeModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const smallModel = { ...largeModel, contextWindow: AUTO_COMPACT_CONTEXT_WINDOW };
		const { session } = await createSession(smallModel);

		expect(session.systemPrompt).toContain(COMPACT_DOCS_MARKER);
		expect(session.systemPrompt).not.toContain(FULL_DOCS_MARKER);
		expect(activeBashDescription(session)).toBe(compactToolDescription(fullBashDescription(session)));

		await session.prompt("Test");

		expect(activeBashDescription(session)).toBe(compactToolDescription(fullBashDescription(session)));
		const sectioned = sectionedSystemMessages(session);
		expect(sectioned.length).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(sectioned[0])).toContain(COMPACT_DOCS_MARKER);
	});

	it("keeps full prompts and tools for a larger-context model", async () => {
		const largeModel = getModel("anthropic", "claude-sonnet-4-5")!;
		expect(largeModel.contextWindow).toBeGreaterThan(AUTO_COMPACT_CONTEXT_WINDOW);
		const { session } = await createSession(largeModel);

		expect(session.systemPrompt).toContain(FULL_DOCS_MARKER);
		expect(session.systemPrompt).not.toContain(COMPACT_DOCS_MARKER);
		expect(activeBashDescription(session)).toBe(fullBashDescription(session));
	});

	it("HUMMIN_COMPACT_PROMPT_AUTO=0 disables the automatic behavior", async () => {
		process.env.HUMMIN_COMPACT_PROMPT_AUTO = "0";
		const largeModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const smallModel = { ...largeModel, contextWindow: AUTO_COMPACT_CONTEXT_WINDOW };
		const { session } = await createSession(smallModel);

		expect(session.systemPrompt).toContain(FULL_DOCS_MARKER);
		expect(activeBashDescription(session)).toBe(fullBashDescription(session));
	});

	it("explicit compactPrompt: true still wins for a large-context model", async () => {
		const largeModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createSession(largeModel, { compactPrompt: true });

		expect(session.systemPrompt).toContain(COMPACT_DOCS_MARKER);
		expect(session.systemPrompt).not.toContain(FULL_DOCS_MARKER);
		expect(activeBashDescription(session)).toBe(compactToolDescription(fullBashDescription(session)));
	});

	it("switching to a small-context model mid-session flips prompt mode on the next turn", async () => {
		const largeModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const smallModel = { ...largeModel, contextWindow: AUTO_COMPACT_CONTEXT_WINDOW };
		const { session } = await createSession(largeModel);

		await session.prompt("First");
		expect(activeBashDescription(session)).toBe(fullBashDescription(session));
		const sectionedAfterFirstPrompt = sectionedSystemMessages(session);
		expect(sectionedAfterFirstPrompt).toHaveLength(1);
		expect(JSON.stringify(sectionedAfterFirstPrompt[0])).toContain(FULL_DOCS_MARKER);

		await session.setModel(smallModel);
		await session.prompt("Second");

		expect(activeBashDescription(session)).toBe(compactToolDescription(fullBashDescription(session)));
		const sectioned = sectionedSystemMessages(session);
		expect(sectioned).toHaveLength(2);
		// The latest sectioned system message is a diff carrying the compact docs block.
		expect(JSON.stringify(sectioned[1])).toContain(COMPACT_DOCS_MARKER);
		expect(JSON.stringify(sectioned[1])).not.toContain(FULL_DOCS_MARKER);
	});
});
