// Transcript tests: the full 2419-entry fixture renders with every entry present, the
// streaming slot reassembles deltas at the component level (mirror of the harness test),
// follow-bottom obeys the 96px dashboard rule, and thinking blocks collapse by default.
//
// Note on virtualization: happy-dom does not implement content-visibility: auto or layout,
// so every row is present in the DOM under test. The render-skipping behavior of
// content-visibility is verified under Playwright against the replay harness in the
// hardening phase, as the spec's verification plan states.
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { AnyRemoteEvent, WireTranscriptEntry } from "../../harness/replay-log.ts";
import { ReplayServer } from "../../harness/replay-server.ts";
import { isNearBottom, FOLLOW_THRESHOLD_PX } from "./follow-bottom.ts";
import { applyStreamEvent, type LiveSlot } from "./stream-slot.ts";
import { TranscriptList } from "./TranscriptList.tsx";
import { expectKind, loadFixtureEvents, snapshotEntries } from "../test/corpus.ts";
import { mount } from "../test/mount.tsx";

describe("TranscriptList", () => {
	it("renders the 2419-entry fixture with every entry present in the DOM", { timeout: 120000 }, async () => {
		const entries: WireTranscriptEntry[] = snapshotEntries(loadFixtureEvents("hummin-longest.events.json"));
		expect(entries.length).toBe(2419);
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const rows = Array.from(mounted.container.querySelectorAll("[data-entry-id]"));
			expect(rows.length).toBe(2419);
			const ids = new Set(rows.map((row) => row.getAttribute("data-entry-id")));
			expect(ids.size).toBe(2419);
			// roles render distinctly
			const roles = new Map<string, number>();
			for (const row of rows) {
				const role = row.getAttribute("data-rc-role") ?? "toolResult";
				roles.set(role, (roles.get(role) ?? 0) + 1);
			}
			expect(roles.get("toolResult")).toBe(1161);
			expect(roles.get("assistant")).toBe(1193);
			expect(roles.get("system")).toBe(11);
			expect(roles.get("user")).toBe(17);
			expect(roles.get("custom")).toBe(37);
			// tool cards bind their toolCallId-shaped block ids through matched results
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
		const streaming = await mount(<TranscriptList entries={[]} slot={slot} />);
		try {
			expect(streaming.container.querySelector("[data-rc-streaming]")?.getAttribute("data-rc-streaming")).toBe("true");
			expect(streaming.container.textContent).toContain("Hi. Ready for a task in this repo or som");
		} finally {
			await streaming.unmount();
		}
		// The fixture snapshot already contains fx-5: a frozen slot with that entryId must
		// not render a second copy next to the landed entry.
		const entries = snapshotEntries(fixture);
		const frozenSlot: LiveSlot = { slotKey: "fx-5", entryId: "fx-5", frozen: true, role: "assistant", blocks: [] };
		const deduped = await mount(<TranscriptList entries={entries} slot={frozenSlot} />);
		try {
			expect(deduped.container.querySelectorAll("[data-entry-id='fx-5']").length).toBe(1);
			expect(deduped.container.querySelectorAll("[data-entry-id]").length).toBe(2419);
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

describe("roles", () => {
	it("renders user, system, and custom roles with their tags", async () => {
		const entries: WireTranscriptEntry[] = [
			{ entryId: "fx-0", message: { role: "user", blocks: [{ type: "text", text: "Hi" }] } },
			{ entryId: "fx-1", message: { role: "system", blocks: [{ type: "text", text: "## Goal" }] } },
			{ entryId: "fx-2", message: { role: "custom", blocks: [{ type: "text", text: "System-1 triage note" }] } },
			{ entryId: "fx-3", message: { role: "assistant", blocks: [{ type: "text", text: "reply" }] } },
		];
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			for (const role of ["user", "system", "custom", "assistant"] as const) {
				expect(mounted.container.querySelector(`[data-rc-role='${role}']`)).not.toBeNull();
			}
			// assistant carries no visible role tag; the others do
			expect(mounted.container.querySelector(".rc-role-tag")).not.toBeNull();
			const tags = Array.from(mounted.container.querySelectorAll(".rc-role-tag")).map((tag) => tag.textContent);
			expect(tags).toEqual(["user", "system", "custom"]);
			expect(mounted.container.querySelectorAll(".rc-md").length).toBeGreaterThan(0);
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
