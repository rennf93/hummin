// No import above hummin-footer.ts may load footer.ts: the two modules import each other, and this
// proves that entering through hummin-footer.ts hits no temporal dead zone.

import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { HumminFooter } from "../src/modes/interactive/components/hummin-footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("hummin-footer.ts as import entry", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("constructs and renders", () => {
		const session = {
			state: { model: undefined, thinkingLevel: "off", messages: [], streamingMessage: undefined },
			sessionManager: { getEntries: () => [], getSessionName: () => "", getCwd: () => "/tmp/project" },
			getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
			modelRuntime: { isUsingSubscription: () => false, getProvider: () => undefined },
			settingsManager: { getStatusline: () => undefined },
		} as unknown as AgentSession;
		const footerData = {
			getGitBranch: () => "main",
			getGitRepoName: () => "hummin",
			getGitStatus: () => null,
			getExtensionStatuses: () => new Map<string, string>(),
			getTodoSummary: () => undefined,
		} as unknown as ReadonlyFooterDataProvider;
		const lines = new HumminFooter(session, footerData).render(120);
		expect(stripAnsi(lines[0])).toContain("/tmp/project");
		expect(stripAnsi(lines[2])).toContain("ctx");
	});
});
