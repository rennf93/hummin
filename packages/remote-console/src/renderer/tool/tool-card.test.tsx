// Corpus-driven tests for tool cards: argumentsError visibility, giant-args truncation,
// mixed-marks error states with durations, name-driven specializations, live phases.
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { WireToolCallBlock } from "../../harness/replay-log.ts";
import { TranscriptList } from "../transcript/TranscriptList.tsx";
import { applyToolUpdate, type ToolLiveState } from "./tool-view.ts";
import { ToolCard } from "./ToolCard.tsx";
import { loadCorpusEvents, snapshotEntries } from "../test/corpus.ts";
import { mount } from "../test/mount.tsx";

/** First toolCall block of a single-entry corpus snapshot, or fails loudly. */
function firstToolCall(file: string): WireToolCallBlock {
	const entry = snapshotEntries(loadCorpusEvents(file))[0];
	const block = entry?.message.blocks.find((b) => b.type === "toolCall");
	if (block?.type !== "toolCall") throw new Error(`${file}: expected a toolCall block`);
	return block;
}

async function expand(mounted: Awaited<ReturnType<typeof mount>>): Promise<void> {
	const row = mounted.container.querySelector<HTMLElement>("button.rc-tool-row");
	if (row === null) throw new Error("tool card row button not found");
	// state updates from user events need act
	await act(async () => {
		row.click();
	});
}

describe("ToolCard", () => {
	it("shows the argumentsError from bad-tool-call visibly without expansion", async () => {
		const call = firstToolCall("bad-tool-call.json");
		expect(call.argumentsError).toContain("missing required field");
		const mounted = await mount(<ToolCard call={call} />);
		try {
			expect(mounted.container.querySelector("[data-rc-tool-state]")).not.toBeNull();
			expect(mounted.container.querySelector("[data-rc-tool-state]")?.getAttribute("data-rc-tool-state")).toBe("error");
			const text = mounted.container.textContent ?? "";
			expect(text).toContain("invalid arguments");
			expect(text).toContain('missing required field "command"');
			expect(Array.from(mounted.container.querySelectorAll(".rc-tool-error")).length).toBeGreaterThan(0);
		} finally {
			await mounted.unmount();
		}
	});

	it("truncates giant-args: 60000-char content never reaches the DOM unbounded", async () => {
		const call = firstToolCall("giant-args.json");
		const mounted = await mount(<ToolCard call={call} />);
		try {
			await expand(mounted);
			const text = mounted.container.textContent ?? "";
			// The 60000-char payload is cut both in the pretty args JSON and in the write body.
			expect(text.length).toBeLessThan(30000);
			expect(mounted.container.querySelectorAll("[data-rc-truncated]").length).toBeGreaterThanOrEqual(2);
			expect(text).toMatch(/of 6\d{4} characters/);
			expect(text).toContain("/tmp/giant-payload.txt");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders bash commands prominently, edit diffs as text, and question choices", async () => {
		// Specialization shapes follow the recorded fixture corpus (sampled from
		// hummin-longest): bash command, edit path + edits pairs, task prompt + cwd,
		// ask_user question + choices, and an unknown tool falling back to generic.
		const bash: WireToolCallBlock = {
			type: "toolCall",
			id: "call-bash",
			name: "bash",
			arguments: { command: "npm test\nvitest run" },
		};
		const edit: WireToolCallBlock = {
			type: "toolCall",
			id: "call-edit",
			name: "edit",
			arguments: {
				path: "/tmp/example/file.ts",
				edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
			},
		};
		const ask: WireToolCallBlock = {
			type: "toolCall",
			id: "call-ask",
			name: "ask_user",
			arguments: {
				question: "Delete the temp worktrees?",
				choices: ["Yes, delete them", "Keep them"],
				allowFreeText: false,
			},
		};
		const task: WireToolCallBlock = {
			type: "toolCall",
			id: "call-task",
			name: "task",
			arguments: { cwd: "/repo", prompt: "run the suite", timeout_sec: 600 },
		};
		const unknown: WireToolCallBlock = { type: "toolCall", id: "call-vault", name: "vault", arguments: { query: "chord slices" } };
		const mounted = await mount(
			<div>
				<ToolCard call={bash} />
				<ToolCard call={edit} />
				<ToolCard call={ask} />
				<ToolCard call={task} />
				<ToolCard call={unknown} />
			</div>,
		);
		try {
			const cards = Array.from(mounted.container.querySelectorAll("[data-rc-tool-name]"));
			expect(cards.length).toBe(5);
			await expandAll(mounted);
			const text = mounted.container.textContent ?? "";
			// bash: the command text is the prominent body
			expect(mounted.container.querySelectorAll(".rc-tool-command").length).toBe(1);
			expect(mounted.container.querySelector(".rc-tool-command")?.textContent).toContain("npm test");
			// edit: path plus textual diff feel
			expect(mounted.container.querySelectorAll(".rc-tool-diff-del").length).toBe(1);
			expect(mounted.container.querySelectorAll(".rc-tool-diff-add").length).toBe(1);
			expect(mounted.container.querySelector(".rc-tool-diff-del")?.textContent).toContain("- const a = 1;");
			expect(mounted.container.querySelector(".rc-tool-diff-add")?.textContent).toContain("+ const a = 2;");
			expect(text).toContain("/tmp/example/file.ts");
			// ask_user: question and both choices
			expect(text).toContain("Delete the temp worktrees?");
			expect(text).toContain("Yes, delete them");
			expect(text).toContain("Keep them");
			// task: brief preview
			expect(text).toContain("run the suite");
			// unknown tool: generic card with raw args JSON
			expect(mounted.container.querySelectorAll("[data-rc-tool-name='vault']").length).toBe(1);
			expect(text).toContain("chord slices");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders mixed-marks toolResults compact with alternating error states and durations", async () => {
		const entries = snapshotEntries(loadCorpusEvents("mixed-marks.json"));
		expect(entries.length).toBe(40);
		const mounted = await mount(<TranscriptList entries={entries} />);
		try {
			const rows = Array.from(mounted.container.querySelectorAll("[data-rc-result-state]"));
			expect(rows.length).toBe(40);
			const errors = rows.filter((row) => row.getAttribute("data-rc-result-state") === "error");
			const done = rows.filter((row) => row.getAttribute("data-rc-result-state") === "done");
			expect(errors.length).toBe(20);
			expect(done.length).toBe(20);
			const text = mounted.container.textContent ?? "";
			expect(text).toContain("100ms");
			expect(text).toContain("107ms");
			// error rows carry the text label, never color alone
			expect(errors[0]?.querySelector(".rc-tool-state")?.textContent).toBe("error");
			expect(done[0]?.querySelector(".rc-tool-state")?.textContent).toBe("done");
		} finally {
			await mounted.unmount();
		}
	});

	it("follows live tool_update phases: start, update, end", async () => {
		const call: WireToolCallBlock = { type: "toolCall", id: "call-live", name: "bash", arguments: { command: "sleep 1" } };
		const mounted = await mount(<ToolCard call={call} live={{ phase: "start" }} />);
		try {
			expect(mounted.container.querySelector("[data-rc-tool-state]")?.getAttribute("data-rc-tool-state")).toBe("running");
			await mounted.render(<ToolCard call={call} live={{ phase: "update", partialResult: "partial output so far" }} />);
			expect(mounted.container.querySelector("[data-rc-tool-state]")?.getAttribute("data-rc-tool-state")).toBe("running");
			await expand(mounted);
			expect((mounted.container.textContent ?? "")).toContain("partial output so far");
			await mounted.render(<ToolCard call={call} live={{ phase: "end", isError: false, durationMs: 1500 }} />);
			expect(mounted.container.querySelector("[data-rc-tool-state]")?.getAttribute("data-rc-tool-state")).toBe("completed");
			expect((mounted.container.textContent ?? "")).toContain("1.5s");
			await mounted.render(<ToolCard call={call} live={{ phase: "end", isError: true, durationMs: 2200 }} />);
			expect(mounted.container.querySelector("[data-rc-tool-state]")?.getAttribute("data-rc-tool-state")).toBe("error");
			expect((mounted.container.textContent ?? "")).toContain("2.2s");
		} finally {
			await mounted.unmount();
		}
	});

	it("folds tool_update events into the live phase map, copy-on-write", () => {
		const empty: ReadonlyMap<string, ToolLiveState> = new Map();
		const started = applyToolUpdate(empty, { toolCallId: "t1", phase: "start", toolName: "bash" });
		const updated = applyToolUpdate(started, { toolCallId: "t1", phase: "update", toolName: "bash", partialResult: "..." });
		const ended = applyToolUpdate(updated, { toolCallId: "t1", phase: "end", toolName: "bash", durationMs: 900 });
		expect(started.get("t1")).toEqual({ phase: "start" });
		expect(updated.get("t1")).toEqual({ phase: "update", partialResult: "..." });
		expect(ended.get("t1")).toEqual({ phase: "end", durationMs: 900 });
		expect(empty.get("t1")).toBeUndefined();
	});
});

async function expandAll(mounted: Awaited<ReturnType<typeof mount>>): Promise<void> {
	for (const row of Array.from(mounted.container.querySelectorAll<HTMLElement>("button.rc-tool-row"))) {
		await act(async () => {
			row.click();
		});
	}
}
