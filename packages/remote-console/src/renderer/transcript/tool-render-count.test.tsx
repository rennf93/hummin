// A tool_update must re-render only the row that owns the updated tool call: every row
// gets just the live states of its own call ids, referentially stable otherwise.
import { describe, expect, it, vi } from "vitest";
import type { WireTranscriptEntry } from "../../harness/replay-log.ts";
import { mount } from "../test/mount.tsx";
import type { ToolLiveState } from "../tool/tool-view.ts";
import { TranscriptList } from "./TranscriptList.tsx";

const renders = vi.hoisted(() => new Map<string, number>());

vi.mock("../tool/ToolCard.tsx", async (importOriginal) => {
	const original = await importOriginal<typeof import("../tool/ToolCard.tsx")>();
	return {
		...original,
		ToolCard: (props: Parameters<typeof original.ToolCard>[0]) => {
			renders.set(props.call.id, (renders.get(props.call.id) ?? 0) + 1);
			return original.ToolCard(props);
		},
	};
});

function toolEntry(id: string): WireTranscriptEntry {
	return {
		entryId: `entry-${id}`,
		message: { role: "assistant", blocks: [{ type: "toolCall", id, name: "bash", arguments: { command: id } }] },
	};
}

describe("tool update rendering", () => {
	it("re-renders only the row whose tool call changed", async () => {
		const entries = [toolEntry("a"), toolEntry("b")];
		const runningA: ToolLiveState = { phase: "start" };
		const runningB: ToolLiveState = { phase: "start" };
		const mounted = await mount(
			<TranscriptList
				entries={entries}
				toolUpdates={
					new Map([
						["a", runningA],
						["b", runningB],
					])
				}
			/>,
		);
		try {
			const before = { a: renders.get("a") ?? 0, b: renders.get("b") ?? 0 };
			expect(before.a).toBeGreaterThan(0);
			// a new map, as the store makes on every tool_update; only "a" gets a new state object
			const updatedA: ToolLiveState = { phase: "update", partialResult: "out" };
			await mounted.render(
				<TranscriptList
					entries={entries}
					toolUpdates={
						new Map([
							["a", updatedA],
							["b", runningB],
						])
					}
				/>,
			);
			expect(renders.get("a")).toBeGreaterThan(before.a);
			expect(renders.get("b")).toBe(before.b);
			expect(mounted.container.querySelectorAll("[data-rc-tool-state='running']").length).toBe(2);
		} finally {
			await mounted.unmount();
		}
	});
});
