import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	parseStatuslineSegments,
	SettingsManager,
	STATUSLINE_TOKENS,
	type StatuslineSettings,
} from "../src/core/settings-manager.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("parseStatuslineSegments", () => {
	it("keeps known and unknown tokens, drops non-strings and empties", () => {
		expect(parseStatuslineSegments(["dir", "model", "  ", 42, null, "branch"])).toEqual(["dir", "model", "branch"]);
	});

	it("trims tokens and keeps unknown ones as literals", () => {
		// Unknown tokens are documented tolerant behavior: kept, rendered dim as-is.
		expect(parseStatuslineSegments([" weather "])).toEqual(["weather"]);
	});

	it("returns empty for non-array input", () => {
		expect(parseStatuslineSegments("dir")).toEqual([]);
		expect(parseStatuslineSegments(undefined)).toEqual([]);
		expect(parseStatuslineSegments(null)).toEqual([]);
	});
});

describe("SettingsManager.getStatusline", () => {
	it("defaults to empty sides when unset", () => {
		expect(SettingsManager.inMemory().getStatusline()).toEqual({ left: [], right: [] });
	});

	it("parses configured sides", () => {
		const config: StatuslineSettings = { left: ["dir", "branch"], right: ["ctx", "cost"] };
		const manager = SettingsManager.inMemory({ statusline: config });
		expect(manager.getStatusline()).toEqual(config);
	});

	it("is tolerant of malformed values", () => {
		const manager = SettingsManager.inMemory({
			statusline: { left: ["dir", 5 as unknown as string], right: "ctx" as unknown as string[] },
		});
		expect(manager.getStatusline()).toEqual({ left: ["dir"], right: [] });
	});

	it("exposes the full known token set", () => {
		expect(STATUSLINE_TOKENS).toContain("dir");
		expect(STATUSLINE_TOKENS).toContain("repo");
		expect(STATUSLINE_TOKENS).toContain("branch");
		expect(STATUSLINE_TOKENS).toContain("model");
		expect(STATUSLINE_TOKENS).toContain("provider");
		expect(STATUSLINE_TOKENS).toContain("ctx");
		expect(STATUSLINE_TOKENS).toContain("tokens");
		expect(STATUSLINE_TOKENS).toContain("cost");
		expect(STATUSLINE_TOKENS).toContain("queue");
		expect(STATUSLINE_TOKENS).toContain("background");
		expect(STATUSLINE_TOKENS).toContain("sandbox");
		expect(STATUSLINE_TOKENS).toContain("mcp");
		expect(STATUSLINE_TOKENS).toContain("git");
		expect(STATUSLINE_TOKENS).toContain("diff");
	});
});

function createStatuslineSession(statusline: StatuslineSettings | undefined): AgentSession {
	const base = {
		pendingMessageCount: 2,
		state: {
			model: {
				id: "glm-5.3",
				provider: "zai",
				contextWindow: 200_000,
				reasoning: false,
				cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [] as Array<Record<string, unknown>>,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => false,
			getProvider: () => undefined,
		},
	};
	const session = {
		...base,
		settingsManager: statusline ? SettingsManager.inMemory({ statusline }) : SettingsManager.inMemory(),
	};
	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getGitRepoName: () => "hummin",
		getGitStatus: () => null,
		getExtensionStatuses: () => new Map<string, string>([["bg", "1 background"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	return provider as unknown as ReadonlyFooterDataProvider;
}

describe("FooterComponent custom statusline", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("falls back to the default three-line footer when statusline is unset", () => {
		const footer = new FooterComponent(createStatuslineSession(undefined), createFooterData());
		const lines = footer.render(120);
		expect(lines.length).toBe(4);
		expect(stripAnsi(lines[0])).toContain("hummin");
		expect(stripAnsi(lines[0])).toContain("main");
		expect(stripAnsi(lines[3])).toContain("1 background");
	});

	it("falls back per row when one side is empty", () => {
		const footer = new FooterComponent(createStatuslineSession({ left: ["dir"], right: [] }), createFooterData());
		const lines = footer.render(120);
		expect(lines.length).toBe(3);
		expect(stripAnsi(lines[0])).toContain("/tmp/project");
		expect(stripAnsi(lines[0])).not.toContain("main");
		expect(stripAnsi(lines[2])).toContain("1 background");
	});

	it("renders user-ordered segments instead of the fixed rows", () => {
		const footer = new FooterComponent(
			createStatuslineSession({ left: ["branch", "repo"], right: ["queue"] }),
			createFooterData(),
		);
		const lines = footer.render(120);
		expect(lines.length).toBe(3);
		const text = stripAnsi(lines[0]);
		expect(text.indexOf("main")).toBeLessThan(text.indexOf("hummin"));
		expect(text).toContain("queue 2");
		expect(text).not.toContain("glm-5.3");
		expect(text).not.toContain("/tmp/project");
	});

	it("renders unknown tokens dim as-is and known-empty tokens as nothing", () => {
		const footer = new FooterComponent(
			createStatuslineSession({ left: ["weather", "branch"], right: ["provider"] }),
			createFooterData(),
		);
		const lines = footer.render(120);
		const text = stripAnsi(lines[0]);
		expect(text).toContain("weather");
		expect(text).toContain("main");
		// provider falls back to the raw provider id when no display name exists
		expect(text).toContain("(zai)");
	});

	it("resolves queue/background/cost segments from footer data", () => {
		const footer = new FooterComponent(
			createStatuslineSession({ left: ["background", "queue"], right: ["cost"] }),
			createFooterData(),
		);
		const text = stripAnsi(footer.render(200)[0]);
		expect(text).toContain("1 background");
		expect(text).toContain("queue 2");
		expect(text).toMatch(/\$0\.000/); // priced model, zero usage so far
	});
});
