import { matchesKey } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	buildFooterNavigatorRows,
	FooterDataProvider,
	parseBackgroundStatusText,
} from "../src/core/footer-data-provider.ts";
import { KEYBINDINGS, KeybindingsManager, matchesFooterNavigatorFastPath } from "../src/core/keybindings.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFooterData(
	overrides: Partial<Record<keyof ReadonlyFooterDataProvider, unknown>> = {},
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getGitRepoName: () => null,
		getGitStatus: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getTodoSummary: () => undefined,
		getAvailableProviderCount: () => 0,
		onBranchChange: () => () => {},
		...overrides,
	};
	return provider as unknown as ReadonlyFooterDataProvider;
}

function createSession(): AgentSession {
	const session = {
		pendingMessageCount: 0,
		state: { model: undefined, thinkingLevel: "off" },
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => undefined,
		modelRuntime: { isUsingSubscription: () => false, getProvider: () => undefined },
	};
	return session as unknown as AgentSession;
}

describe("footer navigator binding", () => {
	it("defaults to alt+down and is documented with the empty-editor fast path", () => {
		expect(KEYBINDINGS["app.footer.navigate"].defaultKeys).toEqual(["alt+down", "down"]);
		expect(KEYBINDINGS["app.footer.navigate"].description).toContain("editor is empty");
	});

	it("resolves through the keybindings manager", () => {
		const manager = new KeybindingsManager();
		expect(manager.matches("\x1b[1;3B", "app.footer.navigate")).toBe(true);
		// "down" is part of the binding (contextual fast path; the editor gates it on emptiness)
		expect(manager.matches("\x1b[B", "app.footer.navigate")).toBe(true);
		expect(manager.matches("x", "app.footer.navigate")).toBe(false);
	});

	it("matches the plain down arrow as the empty-editor fast path", () => {
		const manager = new KeybindingsManager();
		expect(matchesFooterNavigatorFastPath(manager, "\x1b[B")).toBe(true);
		expect(matchesFooterNavigatorFastPath(manager, "x")).toBe(false);
	});

	it("stops treating plain down as the fast path when the user rebinds it away", () => {
		const manager = new KeybindingsManager({ "app.footer.navigate": "ctrl+down" });
		expect(matchesFooterNavigatorFastPath(manager, "\x1b[B")).toBe(false);
		expect(matchesFooterNavigatorFastPath(manager, "\x1b[1;5B")).toBe(true);
	});
});

describe("footer navigator row building", () => {
	it("parses background status text into running and monitor counts", () => {
		expect(parseBackgroundStatusText("2 tasks, 1 monitor")).toEqual({ running: 3, monitors: 1 });
		expect(parseBackgroundStatusText("1 task")).toEqual({ running: 1, monitors: 0 });
		expect(parseBackgroundStatusText(undefined)).toEqual({ running: 0, monitors: 0 });
	});

	it("always shows background and todos, omits empty monitors and unregistered commands", () => {
		const rows = buildFooterNavigatorRows({
			backgroundStatus: undefined,
			todoSummary: undefined,
			agentsAvailable: false,
			fleetAvailable: false,
		});
		expect(rows.map((row) => row.id)).toEqual(["background", "todos"]);
		expect(rows[0].label).toBe("Background tasks (0 running)");
		expect(rows[1].label).toBe("TODOs (none)");
		expect(rows.map((row) => row.command)).toEqual(["/background", "/todos"]);
	});

	it("shows monitors only when some are running", () => {
		const rows = buildFooterNavigatorRows({
			backgroundStatus: "2 tasks, 1 monitor",
			todoSummary: undefined,
			agentsAvailable: false,
			fleetAvailable: false,
		});
		expect(rows.map((row) => row.id)).toEqual(["background", "monitors", "todos"]);
		expect(rows[1].label).toBe("Monitors (1 watching)");
	});

	it("labels todos with live progress and includes registered commands", () => {
		const rows = buildFooterNavigatorRows({
			backgroundStatus: "1 task",
			todoSummary: "4/5 · implement footer navigator",
			agentsAvailable: true,
			fleetAvailable: true,
		});
		expect(rows.map((row) => row.id)).toEqual(["background", "todos", "agents", "fleet"]);
		expect(rows[1].label).toBe("TODOs (4/5)");
		expect(rows[2].command).toBe("/agents");
		expect(rows[3].command).toBe("/fleet");
	});

	it("falls back to TODOs (none) for summaries without x/y progress", () => {
		const rows = buildFooterNavigatorRows({
			backgroundStatus: undefined,
			todoSummary: "just text",
			agentsAvailable: false,
			fleetAvailable: false,
		});
		expect(rows.find((row) => row.id === "todos")?.label).toBe("TODOs (none)");
	});
});

describe("todo summary provider channel", () => {
	it("stores and clears the todo summary", () => {
		const provider = new FooterDataProvider("/tmp");
		expect(provider.getTodoSummary()).toBeUndefined();
		provider.setTodoSummary("4/5 · item");
		expect(provider.getTodoSummary()).toBe("4/5 · item");
		provider.setTodoSummary(undefined);
		expect(provider.getTodoSummary()).toBeUndefined();
		provider.dispose();
	});
});

describe("TODOs footer segment rendering", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders the todo summary as a styled dim-label segment with accent counts", () => {
		const footer = new FooterComponent(
			createSession(),
			createFooterData({ getTodoSummary: () => "4/5 · implement footer navigator" }),
		);
		const lines = footer.render(200);
		const statusLine = lines[lines.length - 1];
		const plain = stripAnsi(statusLine);
		expect(plain).toContain("TODOs 4/5 · implement footer navigator");
		// Accent-colored counts: the counts substring keeps its own styling
		expect(statusLine).toContain("\x1b[");
	});

	it("excludes the raw todo status from the plain extension status line", () => {
		const footer = new FooterComponent(
			createSession(),
			createFooterData({
				getExtensionStatuses: () =>
					new Map([
						["todo", "4/5 · raw"],
						["bg", "1 task"],
					]),
				getTodoSummary: () => "4/5 · styled",
			}),
		);
		const plain = stripAnsi(footer.render(200).at(-1) ?? "");
		expect(plain).not.toContain("raw");
		expect(plain).toContain("TODOs 4/5 · styled");
		expect(plain).toContain("1 task");
	});

	it("hides the todo segment when the summary is cleared", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		const plain = stripAnsi(footer.render(200).at(-1) ?? "");
		expect(plain).not.toContain("TODOs");
	});

	it("matchesKey still routes down for the editor cursor when text is present", () => {
		// Guard for the fast path: the editor only consults it when empty,
		// so plain down must remain the cursor-down binding, not the navigator.
		expect(matchesKey("\x1b[B", "down")).toBe(true);
		expect(KEYBINDINGS["app.footer.navigate"].defaultKeys).not.toBe("down");
	});
});
