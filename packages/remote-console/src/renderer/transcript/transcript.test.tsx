// Transcript tests: the full 2419-entry fixture renders every entry except toolResults
// already shown by their tool row, the streaming slot reassembles deltas at the component
// level (mirror of the harness test), follow-bottom obeys the 96px dashboard rule,
// thinking blocks collapse by default behind a Disclosure, and the working indicator,
// notices and orphan results render in the new quiet visual language.
//
// Note on virtualization: happy-dom does not implement content-visibility: auto or layout,
// so every row is present in the DOM under test. The render-skipping behavior of
// content-visibility is verified under Playwright against the replay harness in the
// hardening phase, as the spec's verification plan states.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AnyRemoteEvent, WireToolCallBlock, WireTranscriptEntry } from "../../harness/replay-log.ts";
import { ReplayServer } from "../../harness/replay-server.ts";
import { isNearBottom, FOLLOW_THRESHOLD_PX } from "./follow-bottom.ts";
import { applyStreamEvent, type LiveSlot } from "./stream-slot.ts";
import { TranscriptList } from "./TranscriptList.tsx";
import { expectKind, loadFixtureEvents, snapshotEntries } from "../test/corpus.ts";
import { mount } from "../test/mount.tsx";

/** toolResult entries whose call block is rendered in the same entries (hidden by the list). */
function matchedToolResults(entries: readonly WireTranscriptEntry[]): WireTranscriptEntry[] {
	const callIds = new Set<string>();
	for (const entry of entries) {
		for (const block of entry.message.blocks) if (block.type === "toolCall") callIds.add(block.id);
	}
	return entries.filter((entry) => entry.message.role === "toolResult" && callIds.has(entry.message.toolCallId ?? ""));
}

/** Entries that should reach the DOM: matched toolResults hidden, and each run of adjacent
 * identical notices (same role, customType, details and text) reduced to its first entry. */
function expectedRows(entries: readonly WireTranscriptEntry[]): WireTranscriptEntry[] {
	const hidden = new Set(matchedToolResults(entries).map((entry) => entry.entryId));
	const rows: WireTranscriptEntry[] = [];
	let previousKey: string | undefined;
	for (const entry of entries) {
		if (hidden.has(entry.entryId)) continue;
		const message = entry.message;
		const textOnly = message.blocks.every((block) => block.type === "text");
		const key =
			(message.role === "system" || message.role === "custom") && textOnly
				? JSON.stringify([message.role, message.customType, message.details, message.blocks.map((block) => block.type === "text" ? block.text : "")])
				: undefined;
		if (key === undefined || key !== previousKey) rows.push(entry);
		previousKey = key;
	}
	return rows;
}

describe("TranscriptList", () => {
	it("renders the 2419-entry fixture: matched toolResults hidden, everything else present", { timeout: 120000 }, async () => {
		const entries: WireTranscriptEntry[] = snapshotEntries(loadFixtureEvents("hummin-longest.events.json"));
		expect(entries.length).toBe(2419);
		const matched = matchedToolResults(entries);
		expect(matched.length).toBeGreaterThan(0);
		const orphans = 1161 - matched.length;
		const expected = expectedRows(entries);
		const expectedRole = (role: string) => expected.filter((entry) => entry.message.role === role).length;
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const rows = Array.from(mounted.container.querySelectorAll("[data-entry-id]"));
			expect(rows.length).toBe(expected.length);
			const ids = new Set(rows.map((row) => row.getAttribute("data-entry-id")));
			expect(ids.size).toBe(expected.length);
			expect(rows.map((row) => row.getAttribute("data-entry-id"))).toEqual(expected.map((entry) => entry.entryId));
			for (const entry of matched) expect(ids.has(entry.entryId)).toBe(false);
			// roles render distinctly
			const roles = new Map<string, number>();
			for (const row of rows) {
				const role = row.getAttribute("data-rc-role") ?? "toolResult";
				roles.set(role, (roles.get(role) ?? 0) + 1);
			}
			expect(roles.get("toolResult") ?? 0).toBe(orphans);
			expect(roles.get("assistant")).toBe(1193);
			expect(roles.get("system") ?? 0).toBe(expectedRole("system"));
			expect(roles.get("user")).toBe(17);
			expect(roles.get("custom") ?? 0).toBe(expectedRole("custom"));
			// every toolCall block renders one tool row
			expect(mounted.container.querySelectorAll("[data-rc-tool-state]").length).toBeGreaterThan(1000);
		} finally {
			await mounted.unmount();
		}
	});

	it("reassembles the streamed message at the component level: joined deltas equal the final text", async () => {
		const fixture = loadFixtureEvents("hummin-longest.events.json");
		const stream = loadFixtureEvents("hummin-longest.stream.events.json");
		const server = new ReplayServer(fixture);
		let slot: LiveSlot | null = null;
		for await (const event of server.simulateStream([...fixture, ...stream])) {
			// Cast is sound: fixture events passed the envelope check in loadFixtureEvents;
			// simulateStream yields the un-narrowed RemoteEvent union form.
			slot = applyStreamEvent(slot, event as AnyRemoteEvent);
		}
		expect(slot?.frozen).toBe(true);
		expect(slot?.entryId).toBe("fx-5");
		const joined = slot?.blocks
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");
		expect(joined).toBe("Hi. Ready for a task in this repo or something else?");
		// Component level: the slot renders the streamed message as a bound, frozen entry.
		const mounted = await mount(<TranscriptList entries={[]} slot={slot} />);
		try {
			const row = mounted.container.querySelector("[data-entry-id='fx-5']");
			expect(row).not.toBeNull();
			expect(row?.getAttribute("data-rc-streaming")).toBeNull();
			expect(row?.textContent).toContain("Hi. Ready for a task in this repo or something else?");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders an unfrozen slot as the live streaming row and dedupes a landed frozen one", async () => {
		const fixture = loadFixtureEvents("hummin-longest.events.json");
		const stream = loadFixtureEvents("hummin-longest.stream.events.json");
		const server = new ReplayServer(fixture);
		let slot: LiveSlot | null = null;
		for await (const event of server.simulateStream(stream)) {
			if (event.type !== "message_end") slot = applyStreamEvent(slot, event as AnyRemoteEvent);
		}
		expect(slot?.frozen).toBe(false);
		// smoothing paces text on rAF; motion off snaps it so the assertion is synchronous
		document.documentElement.setAttribute("data-rc-motion", "off");
		const streaming = await mount(<TranscriptList entries={[]} slot={slot} />);
		try {
			expect(streaming.container.querySelector("[data-rc-streaming]")?.getAttribute("data-rc-streaming")).toBe("true");
			expect(streaming.container.textContent).toContain("Hi. Ready for a task in this repo or som");
		} finally {
			document.documentElement.removeAttribute("data-rc-motion");
			await streaming.unmount();
		}
		// The fixture snapshot already contains fx-5: a frozen slot with that entryId must
		// not render a second copy next to the landed entry.
		const entries = snapshotEntries(fixture);
		const frozenSlot: LiveSlot = { slotKey: "fx-5", entryId: "fx-5", frozen: true, role: "assistant", blocks: [] };
		const deduped = await mount(<TranscriptList entries={entries} slot={frozenSlot} />);
		try {
			expect(deduped.container.querySelectorAll("[data-entry-id='fx-5']").length).toBe(1);
			expect(deduped.container.querySelectorAll("[data-entry-id]").length).toBe(expectedRows(entries).length);
		} finally {
			await deduped.unmount();
		}
	});

	it("collapses thinking blocks by default with a working toggle", async () => {
		const entries: WireTranscriptEntry[] = [
			{
				entryId: "fx-0",
				message: {
					role: "assistant",
					blocks: [
						{ type: "thinking", text: "secret reasoning steps" },
						{ type: "text", text: "the answer" },
					],
				},
			},
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			expect(mounted.container.querySelector("[data-rc-thinking]")?.getAttribute("data-rc-thinking")).toBe("closed");
			expect(mounted.container.textContent).not.toContain("secret reasoning steps");
			const toggle = mounted.container.querySelector<HTMLElement>("button.rc-thinking-toggle");
			expect(toggle).not.toBeNull();
			await act(async () => {
				toggle?.click();
			});
			expect(mounted.container.querySelector("[data-rc-thinking]")?.getAttribute("data-rc-thinking")).toBe("open");
			expect(mounted.container.textContent).toContain("secret reasoning steps");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("live slot handover", () => {
	it("keeps an opened thinking block mounted and does not stamp the landed entry as arrived", async () => {
		const blocks: LiveSlot["blocks"] = [
			{ type: "thinking", text: "private reasoning" },
			{ type: "text", text: "answer" },
		];
		const earlier: WireTranscriptEntry = { entryId: "e0", message: { role: "user", blocks: [{ type: "text", text: "hi" }] } };
		const landedEntry: WireTranscriptEntry = { entryId: "e1", message: { role: "assistant", blocks } };
		const live: LiveSlot = { slotKey: "s1", entryId: null, frozen: false, role: "assistant", blocks };
		const mounted = await mount(<TranscriptList entries={[earlier]} slot={live} />);
		try {
			await act(async () => {
				mounted.container.querySelector<HTMLElement>("button.rc-thinking-toggle")?.click();
			});
			expect(mounted.container.querySelector("[data-rc-thinking]")?.getAttribute("data-rc-thinking")).toBe("open");
			await mounted.render(<TranscriptList entries={[earlier, landedEntry]} slot={null} />);
			const row = mounted.container.querySelector("[data-entry-id='e1']");
			expect(row).not.toBeNull();
			expect(row?.hasAttribute("data-rc-arrived")).toBe(false);
			expect(row?.querySelector("[data-rc-thinking]")?.getAttribute("data-rc-thinking")).toBe("open");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("follow-bottom", () => {
	it("follows only within the 96px threshold", () => {
		expect(FOLLOW_THRESHOLD_PX).toBe(96);
		expect(isNearBottom(0, 1000, 5000)).toBe(false);
		expect(isNearBottom(3904, 1000, 5000)).toBe(true);
		expect(isNearBottom(5000, 1000, 5000)).toBe(true);
		expect(isNearBottom(0, 1000, 0)).toBe(true);
	});

	it("shows the jump affordance when scrolled away and follows again near the bottom", async () => {
		const entries: WireTranscriptEntry[] = [
			{ entryId: "fx-0", message: { role: "user", blocks: [{ type: "text", text: "hello" }] } },
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const scroller = mounted.container.querySelector("[data-rc-scroller]");
			expect(scroller).not.toBeNull();
			const element = scroller as HTMLElement;
			// happy-dom has no layout: pin the metrics the scroll handler reads.
			Object.defineProperty(element, "scrollHeight", { value: 5000, configurable: true });
			Object.defineProperty(element, "clientHeight", { value: 1000, configurable: true });
			element.scrollTop = 0;
			// state updates from the scroll handler need act, as with any user event
			await act(async () => {
				element.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			const jump = mounted.container.querySelector("[data-rc-jump]");
			expect(jump).not.toBeNull();
			await act(async () => {
				jump?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(element.scrollTop).toBe(5000);
			await act(async () => {
				element.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			expect(mounted.container.querySelector("[data-rc-jump]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});

describe("pinning", () => {
	const user = (id: string): WireTranscriptEntry => ({
		entryId: id,
		message: { role: "user", blocks: [{ type: "text", text: id }] },
	});

	it("pins to the bottom when a snapshot replaces the list but never moves a scrolled-up reader", async () => {
		// happy-dom has no layout: give every element a fixed scroll geometry
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 5000 });
		Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 1000 });
		const first = [user("a"), user("b")];
		const mounted = await mount(<TranscriptList entries={first} />);
		try {
			const element = mounted.container.querySelector<HTMLElement>("[data-rc-scroller]");
			if (element === null) throw new Error("scroller not found");
			expect(element.scrollTop).toBe(5000);
			element.scrollTop = 0;
			await act(async () => {
				element.dispatchEvent(new Event("scroll"));
			});
			await mounted.render(<TranscriptList entries={[...first, user("c")]} />);
			expect(element.scrollTop).toBe(0);
			// a wholesale replacement (host switch) opens at the bottom even with the jump pill showing
			await mounted.render(<TranscriptList entries={[user("x"), user("y")]} />);
			expect(element.scrollTop).toBe(5000);
			expect(mounted.container.querySelector("[data-rc-jump]")).toBeNull();
		} finally {
			delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
			delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
			await mounted.unmount();
		}
	});
});

describe("roles", () => {
	it("renders user as a bubble, assistant as prose, and system and custom as quiet notices", async () => {
		const entries: WireTranscriptEntry[] = [
			{ entryId: "fx-0", message: { role: "user", blocks: [{ type: "text", text: "Hi" }] } },
			{ entryId: "fx-1", message: { role: "system", blocks: [{ type: "text", text: "## Goal\nship it" }] } },
			{ entryId: "fx-2", message: { role: "custom", blocks: [{ type: "text", text: "System-1 triage note" }] } },
			{ entryId: "fx-3", message: { role: "assistant", blocks: [{ type: "text", text: "reply" }] } },
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			for (const role of ["user", "system", "custom", "assistant"] as const) {
				expect(mounted.container.querySelector(`[data-rc-role='${role}']`)).not.toBeNull();
			}
			// no role tags anywhere any more
			expect(mounted.container.querySelector(".rc-role-tag")).toBeNull();
			expect(mounted.container.querySelector("[data-rc-role='user'] .rc-md")?.textContent).toBe("Hi");
			expect(mounted.container.querySelector("[data-rc-role='assistant'] .rc-md")?.textContent).toBe("reply");
			// a short single-line notice has no toggle; a multi-line one is a collapsed disclosure
			const custom = mounted.container.querySelector("[data-rc-role='custom']");
			expect(custom?.querySelector(".rc-notice-text")?.textContent).toBe("System-1 triage note");
			expect(custom?.querySelector("button")).toBeNull();
			const system = mounted.container.querySelector("[data-rc-role='system']");
			const toggle = system?.querySelector<HTMLElement>("button.rc-notice-toggle");
			expect(toggle).not.toBeNull();
			expect(system?.querySelector(".rc-notice-text")?.textContent).toBe("Goal");
			expect(system?.querySelector(".rc-md")).toBeNull();
			await act(async () => {
				toggle?.click();
			});
			expect(system?.querySelector(".rc-notice-body")?.textContent).toContain("ship it");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("typed notices", () => {
	const custom = (customType: string | undefined, text: string, details?: Record<string, unknown>): WireTranscriptEntry => ({
		entryId: `n-${customType ?? "plain"}-${text}`,
		message: {
			role: "custom",
			customType,
			details,
			blocks: text === "" ? [] : [{ type: "text", text }],
		},
	});

	async function noticeOf(entry: WireTranscriptEntry) {
		const mounted = await mount(<TranscriptList entries={[entry]} />);
		const notice = mounted.container.querySelector<HTMLElement>(".rc-notice");
		if (notice === null) throw new Error("notice not rendered");
		return { mounted, notice };
	}

	it("memory recall: sparkle icon and a lesson count label with no text blocks", async () => {
		for (const [details, label] of [
			[{ lessonCount: 3 }, "Recalled 3 lessons from memory"],
			[{ lessonCount: 1 }, "Recalled 1 lesson from memory"],
			[{ lessonCount: "3" }, "Recalled lessons from memory"],
			[undefined, "Recalled lessons from memory"],
		] as const) {
			const { mounted, notice } = await noticeOf(custom("hummin-memory-recall", "", details));
			try {
				expect(notice.getAttribute("data-rc-custom-type")).toBe("hummin-memory-recall");
				expect(notice.querySelector(".rc-notice-text")?.textContent).toBe(label);
				expect(notice.querySelector("button")).toBeNull();
				expect(notice.querySelector(".rc-icon")).not.toBeNull();
			} finally {
				await mounted.unmount();
			}
		}
	});

	it("monitor and exec: label then the message text on one line", async () => {
		for (const [type, label] of [
			["hummin-monitor", "Monitor"],
			["hummin-exec", "Exec"],
		] as const) {
			const { mounted, notice } = await noticeOf(custom(type, "build: still running"));
			try {
				expect(notice.getAttribute("data-rc-custom-type")).toBe(type);
				expect(notice.querySelector(".rc-notice-text .rc-label")?.textContent?.trim()).toBe(label);
				expect(notice.querySelector(".rc-notice-text")?.textContent).toBe(`${label} build: still running`);
			} finally {
				await mounted.unmount();
			}
		}
	});

	it("task: label, state, duration and a non-zero exit code as a word; zero exit is omitted", async () => {
		const failed = await noticeOf(
			custom("hummin-task", "tests failed", { label: "suite", state: "failed", durationMs: 2500, exitCode: 2 }),
		);
		try {
			expect(failed.notice.querySelector(".rc-notice-text")?.textContent).toBe("Task suite failed 2.5s exit 2 tests failed");
			expect(failed.notice.querySelector(".rc-notice-bad")?.textContent?.trim()).toBe("exit 2");
		} finally {
			await failed.mounted.unmount();
		}
		const ok = await noticeOf(custom("hummin-task", "", { state: "done", durationMs: 400, exitCode: 0 }));
		try {
			expect(ok.notice.querySelector(".rc-notice-text")?.textContent?.trim()).toBe("Task done 400ms");
			expect(ok.notice.querySelector(".rc-notice-bad")).toBeNull();
		} finally {
			await ok.mounted.unmount();
		}
		const junk = await noticeOf(custom("hummin-task", "x", { label: 1, state: {}, durationMs: "5", exitCode: "1" }));
		try {
			expect(junk.notice.querySelector(".rc-notice-text")?.textContent).toBe("Task x");
		} finally {
			await junk.mounted.unmount();
		}
	});

	it("unknown customType keeps the plain notice with the type as a small label; no customType is unchanged", async () => {
		const other = await noticeOf(custom("acme-thing", "hello"));
		try {
			expect(other.notice.getAttribute("data-rc-custom-type")).toBe("acme-thing");
			expect(other.notice.querySelector(".rc-notice-text .rc-label")?.textContent?.trim()).toBe("acme-thing");
			expect(other.notice.querySelector(".rc-notice-text")?.textContent).toBe("acme-thing hello");
		} finally {
			await other.mounted.unmount();
		}
		const plain = await noticeOf(custom(undefined, "hello"));
		try {
			expect(plain.notice.hasAttribute("data-rc-custom-type")).toBe(false);
			expect(plain.notice.querySelector(".rc-notice-text")?.textContent).toBe("hello");
			expect(plain.notice.querySelector(".rc-label")).toBeNull();
		} finally {
			await plain.mounted.unmount();
		}
	});

	it("a live custom message (start + end, no blocks) renders its typed notice without a reload", async () => {
		const message = { role: "custom" as const, customType: "hummin-memory-recall", details: { lessonCount: 3 }, blocks: [] };
		let slot: LiveSlot | null = applyStreamEvent(null, {
			v: 1,
			seq: 1,
			ts: "2026-01-01T00:00:00.000Z",
			type: "message_start",
			payload: { slotKey: "s1", message },
		});
		slot = applyStreamEvent(slot, {
			v: 1,
			seq: 2,
			ts: "2026-01-01T00:00:00.000Z",
			type: "message_end",
			payload: { slotKey: "s1", entryId: "e1", message },
		});
		const mounted = await mount(<TranscriptList entries={[]} slot={slot} />);
		try {
			const notices = mounted.container.querySelectorAll(".rc-notice");
			expect(notices).toHaveLength(1);
			expect(notices[0]?.getAttribute("data-rc-custom-type")).toBe("hummin-memory-recall");
			expect(notices[0]?.querySelector(".rc-notice-text")?.textContent).toBe("Recalled 3 lessons from memory");
			// Once the entry lands, the same row stays (landed through SlotRow) and keeps the notice.
			await mounted.render(<TranscriptList entries={[{ entryId: "e1", message }]} slot={slot} />);
			expect(mounted.container.querySelectorAll(".rc-notice")).toHaveLength(1);
			expect(mounted.container.querySelector(".rc-notice")?.getAttribute("data-rc-custom-type")).toBe("hummin-memory-recall");
		} finally {
			await mounted.unmount();
		}
	});

	it("a long typed notice keeps its disclosure", async () => {
		const { mounted, notice } = await noticeOf(custom("hummin-monitor", "line one\nline two"));
		try {
			const toggle = notice.querySelector<HTMLElement>("button.rc-notice-toggle");
			expect(toggle).not.toBeNull();
			await act(async () => {
				toggle?.click();
			});
			expect(notice.querySelector(".rc-notice-body")?.textContent).toContain("line two");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("repeated notices", () => {
	const monitor = (id: number, text = "Monitor build: still running"): WireTranscriptEntry => ({
		entryId: `m-${id}`,
		message: { role: "custom", customType: "hummin-monitor", blocks: [{ type: "text", text }] },
	});

	it("collapses 12 identical adjacent notices into one row with a count", async () => {
		const entries = Array.from({ length: 12 }, (_, index) => monitor(index));
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const rows = mounted.container.querySelectorAll("[data-entry-id]");
			expect(rows.length).toBe(1);
			expect(rows[0]?.getAttribute("data-entry-id")).toBe("m-0");
			expect(rows[0]?.getAttribute("data-rc-repeat")).toBe("12");
			expect(rows[0]?.querySelector(".rc-notice-repeat")?.textContent).toBe("x12");
			expect(mounted.container.querySelector("[data-entry-id='m-1']")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("a different text in between breaks the run; single rows carry no count", async () => {
		const entries = [monitor(0), monitor(1), monitor(2, "Monitor build: exited 0"), monitor(3), monitor(4), monitor(5)];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const rows = Array.from(mounted.container.querySelectorAll("[data-entry-id]"));
			expect(rows.map((row) => row.getAttribute("data-entry-id"))).toEqual(["m-0", "m-2", "m-3"]);
			expect(rows.map((row) => row.getAttribute("data-rc-repeat"))).toEqual(["2", null, "3"]);
			expect(rows[1]?.querySelector(".rc-notice-repeat")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("does not merge across customType or role, nor assistant messages with equal text", async () => {
		const assistant = (id: number): WireTranscriptEntry => ({
			entryId: `a-${id}`,
			message: { role: "assistant", blocks: [{ type: "text", text: "same" }] },
		});
		const entries: WireTranscriptEntry[] = [
			monitor(0),
			{ entryId: "x-1", message: { role: "custom", customType: "hummin-exec", blocks: [{ type: "text", text: "Monitor build: still running" }] } },
			{ entryId: "x-2", message: { role: "system", blocks: [{ type: "text", text: "Monitor build: still running" }] } },
			assistant(1),
			assistant(2),
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			expect(mounted.container.querySelectorAll("[data-entry-id]").length).toBe(5);
			expect(mounted.container.querySelectorAll("[data-rc-repeat]").length).toBe(0);
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps recall notices with different counts apart", async () => {
		const recall = (id: number, lessonCount: number): WireTranscriptEntry => ({
			entryId: `r-${id}`,
			message: { role: "custom", customType: "hummin-memory-recall", details: { lessonCount }, blocks: [] },
		});
		const mounted = await mount(<TranscriptList entries={[recall(0, 2), recall(1, 2), recall(2, 5)]} />);
		try {
			const rows = Array.from(mounted.container.querySelectorAll("[data-entry-id]"));
			expect(rows.map((row) => row.getAttribute("data-rc-repeat"))).toEqual(["2", null]);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("tool results", () => {
	const call = (id: string): WireTranscriptEntry => ({
		entryId: `call-${id}`,
		message: { role: "assistant", blocks: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }] },
	});
	const result = (id: string): WireTranscriptEntry => ({
		entryId: `res-${id}`,
		message: { role: "toolResult", toolCallId: id, toolName: "bash", blocks: [{ type: "text", text: "output" }] },
	});

	it("hides a toolResult whose call is rendered and shows the outcome on the tool row", async () => {
		const mounted = await mount(<TranscriptList entries={[call("a"), result("a")]} />);
		try {
			expect(mounted.container.querySelector("[data-entry-id='res-a']")).toBeNull();
			const row = mounted.container.querySelector("[data-rc-tool-state]");
			expect(row?.getAttribute("data-rc-tool-state")).toBe("completed");
			expect(row?.querySelector(".rc-tool-state")?.textContent).toBe("done");
			expect(row?.querySelector(".rc-tool-name")?.textContent).toBe("Ran");
		} finally {
			await mounted.unmount();
		}
	});

	it("still renders an orphan toolResult as a quiet row", async () => {
		const mounted = await mount(<TranscriptList entries={[call("a"), result("zzz")]} />);
		try {
			const orphan = mounted.container.querySelector("[data-entry-id='res-zzz']");
			expect(orphan).not.toBeNull();
			expect(orphan?.getAttribute("data-rc-result-state")).toBe("done");
			expect(orphan?.querySelector(".rc-tool-state")?.textContent).toBe("done");
			expect(orphan?.querySelector(".rc-tool-preview")?.textContent).toBe("output");
		} finally {
			await mounted.unmount();
		}
	});

	it("groups consecutive tool calls of one message", async () => {
		const entries: WireTranscriptEntry[] = [
			{
				entryId: "multi",
				message: {
					role: "assistant",
					blocks: [
						{ type: "toolCall", id: "m1", name: "read", arguments: { path: "/a" } },
						{ type: "toolCall", id: "m2", name: "read", arguments: { path: "/b" } },
						{ type: "text", text: "done" },
					],
				},
			},
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const groups = mounted.container.querySelectorAll(".rc-tool-group");
			expect(groups.length).toBe(1);
			expect(groups[0]?.querySelectorAll("[data-rc-tool-name='read']").length).toBe(2);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("working indicator and live slot", () => {
	const liveSlot = (blocks: LiveSlot["blocks"]): LiveSlot => ({
		slotKey: "s1",
		entryId: null,
		frozen: false,
		role: "assistant",
		blocks,
	});

	it("shows the working line only while working with no visible slot content", async () => {
		const mounted = await mount(<TranscriptList entries={[]} working />);
		try {
			const line = mounted.container.querySelector("[data-rc-working='true']");
			expect(line).not.toBeNull();
			expect(line?.textContent).toBe("Working");
			expect(line?.querySelector(".rc-dot")?.getAttribute("data-activity")).toBe("pulse");
			// an empty live slot is not visible content yet
			await mounted.render(<TranscriptList entries={[]} slot={liveSlot([{ type: "text", text: "" }])} working />);
			expect(mounted.container.querySelector("[data-rc-working]")).not.toBeNull();
			// first token lands: the line leaves
			document.documentElement.setAttribute("data-rc-motion", "off");
			await mounted.render(<TranscriptList entries={[]} slot={liveSlot([{ type: "text", text: "Hello" }])} working />);
			expect(mounted.container.querySelector("[data-rc-working]")).toBeNull();
			await mounted.render(<TranscriptList entries={[]} slot={null} working={false} />);
			expect(mounted.container.querySelector("[data-rc-working]")).toBeNull();
		} finally {
			document.documentElement.removeAttribute("data-rc-motion");
			await mounted.unmount();
		}
	});

	it("labels a live trailing thinking block Thinking and drops the caret", async () => {
		const mounted = await mount(<TranscriptList entries={[]} slot={liveSlot([{ type: "thinking", text: "hmm" }])} />);
		try {
			expect(mounted.container.querySelector("button.rc-thinking-toggle")?.textContent).toBe("Thinking");
			expect(mounted.container.querySelector(".rc-shimmer")).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("renders the empty list as the three-line skeleton", async () => {
		const mounted = await mount(<TranscriptList entries={[]} />);
		try {
			expect(mounted.container.querySelectorAll(".rc-skeleton-line").length).toBe(3);
		} finally {
			await mounted.unmount();
		}
	});

	it.each([
		["connecting", false],
		["reconnecting", false],
		["connected", false],
	] as const)("keeps the skeleton while %s with no snapshot (snapshotReceived=%s)", async (connection, snapshotReceived) => {
		const mounted = await mount(<TranscriptList entries={[]} connection={connection} snapshotReceived={snapshotReceived} />);
		try {
			expect(mounted.container.querySelectorAll(".rc-skeleton-line").length).toBe(3);
			expect(mounted.container.querySelector("[data-rc-empty-state]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it.each([
		["unauthorized", "Not authorized. Reopen the /remote-control URL to reconnect."],
		["unreachable", "Host unreachable. Retrying."],
		["closed", "Disconnected."],
	] as const)("shows a quiet message instead of the skeleton when %s", async (connection, message) => {
		const mounted = await mount(<TranscriptList entries={[]} connection={connection} />);
		try {
			const state = mounted.container.querySelector("[data-rc-empty-state]");
			expect(state?.getAttribute("data-rc-empty-state")).toBe(connection);
			expect(state?.textContent).toBe(message);
			expect(mounted.container.querySelector(".rc-skeleton")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("shows 'No messages yet.' for a connected host whose snapshot was empty", async () => {
		const mounted = await mount(<TranscriptList entries={[]} connection="connected" snapshotReceived />);
		try {
			const state = mounted.container.querySelector("[data-rc-empty-state]");
			expect(state?.getAttribute("data-rc-empty-state")).toBe("connected");
			expect(state?.textContent).toBe("No messages yet.");
			expect(mounted.container.querySelector(".rc-skeleton")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});

// Markdown import is exercised through the transcript rows; keep a direct corpus check
// here so the oversize cap is also asserted in transcript context.
describe("transcript oversize", () => {
	it("caps an oversized assistant block inside the transcript", async () => {
		const entries: WireTranscriptEntry[] = [
			{ entryId: "fx-0", message: { role: "assistant", blocks: [{ type: "text", text: "x".repeat(25000) }] } },
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			expect(mounted.container.querySelectorAll("[data-rc-truncated]").length).toBe(1);
			expect(mounted.container.textContent).toContain("of 25000 characters");
		} finally {
			await mounted.unmount();
		}
	});
});

// Guard the fixture shape the tests above rely on.
describe("fixture shape", () => {
	it("the stream fixture ends with a message_end carrying the streamed turn", () => {
		const stream = loadFixtureEvents("hummin-longest.stream.events.json");
		const lastEvent = stream[3];
		if (lastEvent === undefined) throw new Error("stream fixture is missing its message_end event");
		const endEvent = expectKind(lastEvent, "message_end");
		expect(endEvent.payload.entryId).toBe("fx-5");
	});
});

describe("per-message footer", () => {
	const assistant = (extra: { usage?: { input: number; output: number; total: number }; durationMs?: number }): WireTranscriptEntry => ({
		entryId: "m1",
		message: { role: "assistant", blocks: [{ type: "text", text: "hello" }], ...extra },
	});
	const footer = async (entries: WireTranscriptEntry[], slot?: LiveSlot | null): Promise<string | null | undefined> => {
		const mounted = await mount(<TranscriptList entries={entries} slot={slot} />);
		try {
			return mounted.container.querySelector("[data-rc-msg-meta]")?.textContent;
		} finally {
			await mounted.unmount();
		}
	};

	it("shows tokens only, duration only, both with the rate, or nothing", async () => {
		const usage = { input: 5, output: 39, total: 44 };
		expect(await footer([assistant({ usage })])).toBe("39 tok");
		expect(await footer([assistant({ durationMs: 3200 })])).toBe("3.2s");
		expect(await footer([assistant({ usage: { input: 1, output: 124, total: 125 }, durationMs: 10000 })])).toBe(
			"124 tok \u00b7 10s \u00b7 12.4 tok/s",
		);
		expect(await footer([assistant({})])).toBeUndefined();
	});

	it("shows none while streaming and once after the slot lands", async () => {
		const usage = { input: 1, output: 10, total: 11 };
		const live: LiveSlot = {
			slotKey: "s1", entryId: null, frozen: false, role: "assistant", blocks: [{ type: "text", text: "hi" }], usage, durationMs: 1000,
		};
		document.documentElement.setAttribute("data-rc-motion", "off");
		const mounted = await mount(<TranscriptList entries={[]} slot={live} />);
		try {
			expect(mounted.container.querySelector("[data-rc-msg-meta]")).toBeNull();
			const landed = assistant({ usage, durationMs: 1000 });
			await mounted.render(<TranscriptList entries={[landed]} slot={null} />);
			const metas = mounted.container.querySelectorAll("[data-rc-msg-meta]");
			expect(metas.length).toBe(1);
			expect(metas[0]?.textContent).toBe("10 tok \u00b7 1s \u00b7 10.0 tok/s");
		} finally {
			document.documentElement.removeAttribute("data-rc-motion");
			await mounted.unmount();
		}
	});
});

describe("transcript hardening", () => {
	const user = (entryId: string, text: string): WireTranscriptEntry => ({
		entryId,
		message: { role: "user", blocks: [{ type: "text", text }] },
	});

	it("keys rows by position when an older server sends empty ids, without key collisions", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const mounted = await mount(<TranscriptList entries={[user("", "first"), user("", "second"), user("", "third")]} />);
		try {
			const rows = Array.from(mounted.container.querySelectorAll("article"));
			expect(rows.map((row) => row.textContent)).toEqual(["first", "second", "third"]);
			expect(errors.mock.calls.filter((call) => String(call[0]).includes("same key"))).toEqual([]);
		} finally {
			errors.mockRestore();
			await mounted.unmount();
		}
	});

	it("animates the first live entry in an empty transcript but not a snapshot that fills it", async () => {
		const mounted = await mount(<TranscriptList entries={[]} />);
		try {
			await mounted.render(<TranscriptList entries={[user("a", "live")]} />);
			expect(mounted.container.querySelector("[data-entry-id='a']")?.getAttribute("data-rc-arrived")).toBe("true");
		} finally {
			await mounted.unmount();
		}
		const snapshot = await mount(<TranscriptList entries={[]} />);
		try {
			await snapshot.render(<TranscriptList entries={[user("a", "x"), user("b", "y"), user("c", "z")]} />);
			expect(snapshot.container.querySelectorAll("[data-rc-arrived]").length).toBe(0);
			await snapshot.render(<TranscriptList entries={[user("a", "x"), user("b", "y"), user("c", "z"), user("d", "w")]} />);
			expect(snapshot.container.querySelector("[data-entry-id='d']")?.getAttribute("data-rc-arrived")).toBe("true");
		} finally {
			await snapshot.unmount();
		}
	});

	it("marks the content wrapper as a polite log and the streaming row busy", async () => {
		const live: LiveSlot = { slotKey: "s", entryId: null, frozen: false, role: "assistant", blocks: [{ type: "text", text: "partial" }] };
		const mounted = await mount(<TranscriptList entries={[]} slot={live} />);
		try {
			const log = mounted.container.querySelector(".rc-transcript-content");
			expect(log?.getAttribute("role")).toBe("log");
			expect(log?.getAttribute("aria-label")).toBe("transcript");
			expect(log?.getAttribute("aria-relevant")).toBe("additions");
			expect(mounted.container.querySelector("[data-rc-streaming]")?.getAttribute("aria-busy")).toBe("true");
			await mounted.render(<TranscriptList entries={[]} slot={{ ...live, frozen: true, entryId: "e" }} />);
			expect(mounted.container.querySelector("article")?.hasAttribute("aria-busy")).toBe(false);
		} finally {
			await mounted.unmount();
		}
	});

	it("gives a notice that the three-line clamp cuts a toggle; a short one stays plain", async () => {
		const notice = (text: string): WireTranscriptEntry => ({
			entryId: "n",
			message: { role: "system", blocks: [{ type: "text", text }] },
		});
		const plain = await mount(<TranscriptList entries={[notice("short")]} />);
		try {
			expect(plain.container.querySelector("button.rc-notice-toggle")).toBeNull();
		} finally {
			await plain.unmount();
		}
		// happy-dom has no layout: report the notice text as taller than its box
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return this.classList.contains("rc-notice-text") ? 100 : 0;
			},
		});
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return this.classList.contains("rc-notice-text") ? 40 : 0;
			},
		});
		const clipped = await mount(<TranscriptList entries={[notice("short")]} />);
		try {
			const toggle = clipped.container.querySelector<HTMLElement>("button.rc-notice-toggle");
			expect(toggle).not.toBeNull();
			expect(toggle?.hasAttribute("aria-controls")).toBe(false);
			await act(async () => {
				toggle?.click();
			});
			const body = clipped.container.querySelector(".rc-notice-body");
			expect(toggle?.getAttribute("aria-controls")).toBe(body?.id);
			expect(body?.id).not.toBe("");
		} finally {
			Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
			Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
			await clipped.unmount();
		}
	});

	it("points aria-controls at the thinking and tool bodies only while expanded", async () => {
		const entry: WireTranscriptEntry = {
			entryId: "a",
			message: {
				role: "assistant",
				blocks: [
					{ type: "thinking", text: "reasoning" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				],
			},
		};
		const mounted = await mount(<TranscriptList entries={[entry]} />);
		try {
			for (const selector of ["button.rc-thinking-toggle", "button.rc-tool-row"]) {
				const toggle = mounted.container.querySelector<HTMLElement>(selector);
				expect(toggle?.hasAttribute("aria-controls")).toBe(false);
				await act(async () => {
					toggle?.click();
				});
				const id = toggle?.getAttribute("aria-controls") ?? "";
				expect(id).not.toBe("");
				expect(mounted.container.querySelector(`[id="${id}"]`)).not.toBeNull();
			}
		} finally {
			await mounted.unmount();
		}
	});

	it("renders a tool call whose arguments are null or not an object", async () => {
		for (const bad of [null, "text", 7, [1, 2]]) {
			const call = { type: "toolCall", id: "t", name: "bash", arguments: bad } as unknown as WireToolCallBlock;
			const entry: WireTranscriptEntry = { entryId: "a", message: { role: "assistant", blocks: [call] } };
			const mounted = await mount(<TranscriptList entries={[entry]} />);
			try {
				expect(mounted.container.querySelector("[data-rc-tool-name='bash']")).not.toBeNull();
				expect(mounted.container.querySelector(".rc-tool-preview")?.textContent).toBe("{}");
				await act(async () => {
					mounted.container.querySelector<HTMLElement>("button.rc-tool-row")?.click();
				});
				expect(mounted.container.querySelector(".rc-tool-body")).not.toBeNull();
			} finally {
				await mounted.unmount();
			}
		}
	});
});
