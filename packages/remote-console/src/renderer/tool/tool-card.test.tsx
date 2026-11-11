// Corpus-driven tests for tool cards: argumentsError visibility, giant-args truncation,
// mixed-marks error states with durations, name-driven specializations, live phases.
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { WireToolCallBlock } from "../../harness/replay-log.ts";
import { TranscriptList } from "../transcript/TranscriptList.tsx";
import { applyToolUpdate, argsPreview, specializeTool, toolVerb, type ToolLiveState } from "./tool-view.ts";
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
		const unknown: WireToolCallBlock = { type: "toolCall", id: "call-mystery", name: "mystery", arguments: { query: "chord slices" } };
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
			expect(mounted.container.querySelectorAll("[data-rc-tool-name='mystery']").length).toBe(1);
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

	it("derives a human verb per specialization, present form until the call has an outcome", async () => {
		const verbOf = (name: string, state: "queued" | "running" | "completed" | "error") =>
			toolVerb(specializeTool(name, {}).kind, state, name);
		expect(verbOf("bash", "completed")).toBe("Ran");
		expect(verbOf("bash", "running")).toBe("Running");
		expect(verbOf("read", "completed")).toBe("Read");
		expect(verbOf("read", "running")).toBe("Reading");
		expect(verbOf("write", "completed")).toBe("Wrote");
		expect(verbOf("write", "running")).toBe("Writing");
		expect(verbOf("edit", "completed")).toBe("Edited");
		expect(verbOf("edit", "running")).toBe("Editing");
		expect(verbOf("task", "completed")).toBe("Started task");
		expect(verbOf("task", "running")).toBe("Starting task");
		expect(verbOf("ask_user", "completed")).toBe("Asked");
		expect(verbOf("vault", "completed")).toBe("Searched vault");
		expect(verbOf("vault", "running")).toBe("Searching vault");
		expect(verbOf("todo", "completed")).toBe("Updated todos");
		expect(verbOf("task_status", "completed")).toBe("Checked task");
		expect(verbOf("task_cancel", "completed")).toBe("Cancelled task");
		expect(verbOf("mystery", "completed")).toBe("mystery");
		const call: WireToolCallBlock = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
		const mounted = await mount(<ToolCard call={call} live={{ phase: "start" }} />);
		try {
			const name = mounted.container.querySelector(".rc-tool-name");
			expect(name?.textContent).toBe("Running");
			expect(name?.querySelector(".rc-shimmer")).not.toBeNull();
			expect(mounted.container.querySelector(".rc-tool-state")?.textContent).toBe("running");
			expect(mounted.container.querySelector(".rc-tool-glyph .rc-icon-spinner")).not.toBeNull();
			await mounted.render(<ToolCard call={call} live={{ phase: "end", durationMs: 40 }} />);
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Ran");
			expect(mounted.container.querySelector(".rc-tool-name .rc-shimmer")).toBeNull();
			// the finish swaps the icon and pops it; the state word stays in the DOM
			expect(mounted.container.querySelector(".rc-tool-glyph .rc-pop")).not.toBeNull();
			expect(mounted.container.querySelector(".rc-tool-state")?.textContent).toBe("done");
			expect(mounted.container.querySelector(".rc-tool-row .rc-chevron")).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("does not pop the icon of a row that mounts already finished", async () => {
		const call: WireToolCallBlock = { type: "toolCall", id: "c2", name: "read", arguments: { path: "/a" } };
		const mounted = await mount(<ToolCard call={call} result={{ isError: false, text: "x" }} />);
		try {
			expect(mounted.container.querySelector(".rc-tool-glyph .rc-pop")).toBeNull();
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Read");
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

function callOf(name: string, args: Record<string, unknown>): WireToolCallBlock {
	return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

async function mountExpanded(call: WireToolCallBlock, result: { isError: boolean; text: string } = { isError: false, text: "ok" }) {
	const mounted = await mount(<ToolCard call={call} result={result} />);
	await expand(mounted);
	return mounted;
}

describe("hummin tool specializations", () => {
	it("vault: verb, query preview and expanded query plus result text", async () => {
		const call = callOf("vault", { query: "chord slices" });
		expect(argsPreview("vault", call.arguments)).toBe("chord slices");
		const mounted = await mountExpanded(call, { isError: false, text: "found 2 notes" });
		try {
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Searched vault");
			expect(mounted.container.querySelector(".rc-tool-preview")?.textContent).toBe("chord slices");
			const text = mounted.container.textContent ?? "";
			expect(text).toContain("query");
			expect(text).toContain("found 2 notes");
		} finally {
			await mounted.unmount();
		}
	});

	it("vault: malformed args fall back to the JSON glance without throwing", async () => {
		const call = callOf("vault", { query: 42 });
		expect(specializeTool("vault", call.arguments)).toEqual({ kind: "vault", query: "" });
		const mounted = await mountExpanded(call);
		try {
			expect(mounted.container.querySelector(".rc-tool-preview")?.textContent).toContain("42");
		} finally {
			await mounted.unmount();
		}
	});

	it("todo: summary preview and a status-marked checklist, skipping malformed items", async () => {
		const todos = [
			{ text: "write tests", status: "completed" },
			{ text: "wire renderer", status: "in_progress" },
			{ text: "ship it", status: "pending" },
			{ text: "bad status", status: "blocked" },
			{ status: "pending" },
			"junk",
			null,
		];
		expect(argsPreview("todo", { todos })).toBe("1 of 3 done");
		const mounted = await mountExpanded(callOf("todo", { todos }));
		try {
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Updated todos");
			const rows = Array.from(mounted.container.querySelectorAll(".rc-todo"));
			expect(rows.map((row) => row.getAttribute("data-rc-todo-status"))).toEqual(["completed", "in_progress", "pending"]);
			expect(rows[0]?.querySelector(".rc-todo-text")?.textContent).toBe("write tests");
			// the in-progress marker is a word as well as an icon
			expect(rows[1]?.querySelector(".rc-todo-state")?.textContent).toBe("in progress");
			expect(rows[0]?.querySelector(".rc-todo-state")).toBeNull();
			expect(mounted.container.querySelector(".rc-todo-list")?.textContent).not.toContain("bad status");
		} finally {
			await mounted.unmount();
		}
	});

	it("todo: an empty or malformed list shows No todos", async () => {
		for (const args of [{ todos: [] }, { todos: "nope" }, {}]) {
			const mounted = await mountExpanded(callOf("todo", args));
			try {
				expect(mounted.container.querySelector(".rc-tool-empty")?.textContent).toBe("No todos");
				expect(mounted.container.querySelector(".rc-tool-preview")?.textContent).toBe("No todos");
			} finally {
				await mounted.unmount();
			}
		}
	});

	it("monitor: verb by action, preview by name then command then id, command well and meta line", async () => {
		const verbFor = (args: Record<string, unknown>) => {
			const spec = specializeTool("monitor", args);
			return toolVerb(spec.kind, "completed", "monitor", spec);
		};
		expect(verbFor({ action: "start" })).toBe("Started monitor");
		expect(verbFor({ action: "status" })).toBe("Checked monitor");
		expect(verbFor({ action: "stop" })).toBe("Stopped monitor");
		expect(verbFor({ action: "explode" })).toBe("Monitor");
		expect(argsPreview("monitor", { action: "start", name: "tests", command: "npm test", id: "m1" })).toBe("tests");
		expect(argsPreview("monitor", { action: "start", command: "npm test", id: "m1" })).toBe("npm test");
		expect(argsPreview("monitor", { action: "stop", id: "m1" })).toBe("m1");
		const mounted = await mountExpanded(
			callOf("monitor", { action: "start", command: "tail -f log", match: "ERROR", interval_sec: 30, timeout_sec: 600 }),
		);
		try {
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Started monitor");
			expect(mounted.container.querySelector(".rc-tool-command")?.textContent).toBe("tail -f log");
			const meta = mounted.container.querySelector(".rc-tool-meta")?.textContent ?? "";
			expect(meta).toContain("ERROR");
			expect(meta).toContain("30s");
			expect(meta).toContain("10m");
		} finally {
			await mounted.unmount();
		}
	});

	it("monitor: malformed args render no command well or meta line", async () => {
		const mounted = await mountExpanded(
			callOf("monitor", { action: 7, command: ["x"], match: 1, interval_sec: "soon", timeout_sec: Number.NaN }),
		);
		try {
			expect(mounted.container.querySelector(".rc-tool-command")).toBeNull();
			expect(mounted.container.querySelector(".rc-tool-meta")).toBeNull();
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Monitor");
		} finally {
			await mounted.unmount();
		}
	});

	it("task: Started task verb, prompt, and a meta line with persona, model, thinking, background and timeout", async () => {
		const mounted = await mountExpanded(
			callOf("task", {
				prompt: "run the suite",
				persona: "reviewer",
				model: "glm-fast",
				thinking: "low",
				background: true,
				timeout_sec: 90,
			}),
		);
		try {
			expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe("Started task");
			expect(mounted.container.textContent).toContain("run the suite");
			const meta = Array.from(mounted.container.querySelectorAll(".rc-tool-meta-item")).map((item) => item.textContent);
			expect(meta).toEqual(["persona reviewer", "model glm-fast", "thinking low", "background yes", "timeout 1.5m"]);
		} finally {
			await mounted.unmount();
		}
	});

	it("task: no meta line when none of the optional fields are valid", async () => {
		const mounted = await mountExpanded(callOf("task", { prompt: "p", persona: 3, background: "yes" }));
		try {
			expect(mounted.container.querySelector(".rc-tool-meta")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("task_status and task_cancel: verbs and task_id preview, malformed id falls back", async () => {
		for (const [name, verb] of [
			["task_status", "Checked task"],
			["task_cancel", "Cancelled task"],
		] as const) {
			const mounted = await mount(<ToolCard call={callOf(name, { task_id: "t-42" })} result={{ isError: false, text: "ok" }} />);
			try {
				expect(mounted.container.querySelector(".rc-tool-name")?.textContent).toBe(verb);
				expect(mounted.container.querySelector(".rc-tool-preview")?.textContent).toBe("t-42");
			} finally {
				await mounted.unmount();
			}
		}
		expect(argsPreview("task_status", { task_id: 5 })).toContain("5");
	});
});
