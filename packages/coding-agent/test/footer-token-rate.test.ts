import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatTokenRate } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type LastMessage = {
	role: "assistant" | "toolResult";
	usage: { input: number; output: number };
};

function createSession(last?: LastMessage): AgentSession {
	const messages: LastMessage[] = last ? [last] : [];
	return {
		state: { model: undefined, thinkingLevel: "off", messages, streamingMessage: undefined },
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: { isUsingSubscription: () => false, getProvider: () => undefined },
		settingsManager: { getStatusline: () => undefined },
	} as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getGitRepoName: () => "hummin",
		getGitStatus: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getTodoSummary: () => undefined,
		getAvailableProviderCount: () => 1,
		onBranchChange: (cb: () => void) => {
			void cb;
			return () => {};
		},
	} as unknown as ReadonlyFooterDataProvider;
}

/** Right half of the stats row (row index 2) for the live tok/s integration test. */
function statsRow(footer: FooterComponent): string {
	return stripAnsi(footer.render(120)[2]);
}

/** Bump the in-flight assistant response's completion-token count (test only). */
function setOutput(session: AgentSession, output: number): void {
	const streaming = (session.state as { streamingMessage?: LastMessage }).streamingMessage;
	if (!streaming) throw new Error("no streaming message");
	streaming.usage.output = output;
}

/** Start streaming a partial assistant message (test only). */
function startStreaming(session: AgentSession, output = 0): void {
	(session.state as { streamingMessage?: LastMessage }).streamingMessage = {
		role: "assistant",
		usage: { input: 0, output },
	};
}

/** End streaming: the partial moves into messages and streamingMessage clears. */
function endStreaming(session: AgentSession, output: number): void {
	(session.state as { streamingMessage?: LastMessage }).streamingMessage = undefined;
	(session.state as { messages: LastMessage[] }).messages.push({ role: "assistant", usage: { input: 0, output } });
}

beforeAll(() => {
	initTheme(undefined, false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("formatTokenRate", () => {
	it("shows one decimal below 100 tok/s and integer above", () => {
		expect(formatTokenRate(45.23)).toBe("45.2");
		expect(formatTokenRate(120.9)).toBe("121");
	});

	it("renders non-finite rates as a placeholder", () => {
		expect(formatTokenRate(Number.NaN)).toBe("?");
		expect(formatTokenRate(Infinity)).toBe("?");
	});
});

describe("FooterComponent live token rate", () => {
	it("hides the indicator before any output has been generated", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const session = createSession();
		startStreaming(session, 0);
		const footer = new FooterComponent(session, createFooterData());
		expect(statsRow(footer)).not.toContain("tok/s");
	});

	it("formats a 100-token / 2s generation as 50.0 tok/s", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const session = createSession();
		startStreaming(session);
		const footer = new FooterComponent(session, createFooterData());
		footer.render(120); // anchor tick: no value yet
		vi.spyOn(Date, "now").mockReturnValue(3000);
		setOutput(session, 100); // 50 tok/s
		expect(statsRow(footer)).toMatch(/tok\/s 50\.0\b/);
	});

	it("smooths the next delta with an EMA and stays next to the ctx bar", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const session = createSession();
		startStreaming(session);
		const footer = new FooterComponent(session, createFooterData());
		footer.render(120);
		vi.spyOn(Date, "now").mockReturnValue(3000);
		setOutput(session, 100); // 50 tok/s
		expect(statsRow(footer)).toMatch(/tok\/s 50\.0\b/);
		vi.spyOn(Date, "now").mockReturnValue(4000);
		setOutput(session, 200); // raw 100; smoothed = 0.35*100 + 0.65*50 = 67.5
		expect(statsRow(footer)).toMatch(/tok\/s 67\.5\b/);
		// Right-side group keeps tok/s immediately left of the ctx meter.
		expect(statsRow(footer)).toMatch(/tok\/s 67\.5 .*ctx /);
	});

	it("does not show the rate for a completed response resting in messages", () => {
		// Regression: the rate was originally read from state.messages, where the
		// final assistant message lands only after streaming ends - so the live
		// indicator could never appear. Only state.streamingMessage counts.
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const session = createSession({ role: "assistant", usage: { input: 10, output: 500 } });
		const footer = new FooterComponent(session, createFooterData());
		footer.render(120);
		expect(statsRow(footer)).not.toContain("tok/s");
	});

	it("clears the indicator while tool execution or idle stalls generation", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const session = createSession();
		startStreaming(session);
		const footer = new FooterComponent(session, createFooterData());
		footer.render(120);
		vi.spyOn(Date, "now").mockReturnValue(3000);
		setOutput(session, 100);
		expect(statsRow(footer)).toContain("tok/s");
		endStreaming(session, 100);
		vi.spyOn(Date, "now").mockReturnValue(4000);
		expect(statsRow(footer)).not.toContain("tok/s");
	});
});
