/// <reference lib="dom" />
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTitle, loadNotify, saveNotify, useAttention } from "./attention.ts";
import type { WireApproval } from "./harness/replay-log.ts";

const hold = (id: string, args = "ls -la"): WireApproval => ({
	id,
	toolName: "bash",
	argsPreview: args,
	deadlineMs: 9999,
	createdAt: "t",
});

describe("formatTitle", () => {
	it("uses the session name, then the host label, then the console name", () => {
		expect(formatTitle("fix bug", "laptop", 0)).toBe("fix bug - hummin");
		expect(formatTitle(null, "laptop", 0)).toBe("laptop - hummin");
		expect(formatTitle("", null, 0)).toBe("hummin console - hummin");
	});

	it("prefixes the pending approval count", () => {
		expect(formatTitle("fix bug", "laptop", 2)).toBe("(2) Approval - fix bug - hummin");
	});
});

describe("notify opt-in storage", () => {
	beforeEach(() => localStorage.clear());

	it("round-trips on and off, defaulting to off", () => {
		expect(loadNotify()).toBe(false);
		saveNotify(true);
		expect(localStorage.getItem("rc.notify")).toBe("on");
		expect(loadNotify()).toBe(true);
		saveNotify(false);
		expect(localStorage.getItem("rc.notify")).toBe("off");
		expect(loadNotify()).toBe(false);
	});

	it("survives a throwing localStorage", () => {
		const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		expect(loadNotify()).toBe(false);
		spy.mockRestore();
	});
});

describe("useAttention notifications", () => {
	const made: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }> =
		[];
	let hidden = true;
	let root: ReturnType<typeof createRoot>;
	let container: HTMLDivElement;

	function Probe(props: { holds: readonly WireApproval[]; ready: boolean; scope: string }) {
		useAttention({ sessionName: "s1", hostLabel: "h", working: false, ...props });
		return null;
	}
	const render = (holds: readonly WireApproval[], ready = true, scope = "a") =>
		act(async () => root.render(createElement(Probe, { holds, ready, scope })));

	beforeEach(() => {
		made.length = 0;
		hidden = true;
		localStorage.clear();
		saveNotify(true);
		class FakeNotification {
			static permission = "granted";
			onclick: (() => void) | null = null;
			close = vi.fn();
			title: string;
			options: NotificationOptions;
			constructor(title: string, options: NotificationOptions) {
				this.title = title;
				this.options = options;
				made.push(this);
			}
		}
		vi.stubGlobal("Notification", FakeNotification);
		vi.stubGlobal("isSecureContext", true);
		Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
		container = document.createElement("div");
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
		Reflect.deleteProperty(document, "hidden");
	});

	it("notifies once per new hold, never for holds present at mount", async () => {
		await render([hold("a")]);
		expect(made).toHaveLength(0);
		await render([hold("a"), hold("b", "rm -rf x\nmore")]);
		await render([hold("a"), hold("b")]);
		expect(made).toHaveLength(1);
		expect(made[0]?.title).toBe("Approval needed - s1");
		expect(made[0]?.options).toMatchObject({ body: "bash: rm -rf x", tag: "b" });
		const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
		made[0]?.onclick?.();
		expect(focus).toHaveBeenCalled();
		expect(made[0]?.close).toHaveBeenCalled();
	});

	it("never notifies for holds in the first snapshot, only later ones, and re-seeds on a scope change", async () => {
		await render([], false);
		await render([hold("h1")], true);
		expect(made).toHaveLength(0);
		await render([hold("h1"), hold("h2")]);
		expect(made).toHaveLength(1);
		await render([hold("h3")], true, "b");
		expect(made).toHaveLength(1);
	});

	it("stays silent when the tab is visible or the user has not opted in", async () => {
		await render([]);
		hidden = false;
		await render([hold("a")]);
		hidden = true;
		saveNotify(false);
		await render([hold("a"), hold("b")]);
		expect(made).toHaveLength(0);
	});
});
