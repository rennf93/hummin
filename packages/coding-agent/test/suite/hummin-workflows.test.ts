import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { recallLessons } from "../../extensions/hummin-memory.ts";
import sessionExtension from "../../extensions/hummin-session.ts";
import { CheckpointStore, type FileCheckpoint } from "../../extensions/lib/checkpoints.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

beforeAll(() => initTheme("dark"));

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

it("keeps the task constraint in the next provider request after compaction", async () => {
	const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage("I will preserve notes.md"),
		fauxAssistantMessage("Inspected the formatter"),
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("Preserve notes.md");
			return fauxAssistantMessage(
				"Constraint: Preserve notes.md. Remaining task: repair the formatter's zero handling.",
			);
		},
		fauxAssistantMessage("Latest turn: inspected the formatter; no files changed."),
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("Preserve notes.md");
			expect(JSON.stringify(context.messages)).toContain("Continue the repair");
			return fauxAssistantMessage("Continuing with notes.md untouched");
		},
	]);
	await harness.session.prompt("Preserve notes.md while repairing the formatter");
	await harness.session.prompt("Inspect the formatter first");
	await harness.session.compact();
	await harness.session.prompt("Continue the repair");
	expect(harness.faux.state.callCount).toBe(5);
	expect(harness.session.getLastAssistantText()).toContain("untouched");
});

it("delivers relevant memory without unrelated cross-project notes and keeps relevance ahead of age", async () => {
	const memory = mkdtempSync(join(tmpdir(), "hummin-memory-eval-"));
	directories.push(memory);
	vi.stubEnv("HUMMIN_MEMORY_DIR", memory);
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", (event, ctx) => ({
					message: {
						customType: "memory-eval",
						display: false,
						content: recallLessons(ctx.cwd, event.prompt).join("\n"),
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	writeFileSync(
		join(memory, "lessons.jsonl"),
		[
			{ cwd: harness.tempDir, lesson: "invoice decimal quantity parsing must preserve fractions" },
			...Array.from({ length: 1000 }, () => ({ cwd: harness.tempDir, lesson: "unrelated deployment observation" })),
			{ cwd: "/other/project", lesson: "unrelated secret garden note" },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	expect(recallLessons(harness.tempDir, "invoice decimal quantity parsing")[0]).toContain("fractions");
	harness.setResponses([
		(context) => {
			const text = JSON.stringify(context.messages);
			expect(text).toContain("fractions");
			expect(text).not.toContain("secret garden");
			return fauxAssistantMessage("Memory received");
		},
	]);
	await harness.session.prompt("Repair invoice decimal quantity parsing");
});

it("records actual write-tool changes and rewinds files through the command handler", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "hummin-checkpoint-agent-"));
	directories.push(agentDir);
	vi.stubEnv("HUMMIN_CODING_AGENT_DIR", agentDir);
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				const api: ExtensionAPI = {
					...pi,
					registerCommand: (name, command) => {
						commands.set(name, command);
						pi.registerCommand(name, command);
					},
				};
				sessionExtension(api);
			},
		],
	});
	harnesses.push(harness);
	const file = join(harness.tempDir, "draft.txt");
	writeFileSync(file, "human draft");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "draft.txt", content: "agent edit" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Edit the draft");
	expect(readFileSync(file, "utf8")).toBe("agent edit");
	const records = harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "hummin-file-checkpoint" ? [entry.data as FileCheckpoint] : [],
		);
	expect(records).toHaveLength(1);
	const notify = vi.fn();
	const ctx = {
		cwd: harness.tempDir,
		sessionManager: harness.sessionManager,
		isIdle: () => true,
		ui: {
			select: async (_title: string, options: string[]) =>
				options.includes("Files only") ? "Files only" : options[0],
			confirm: async () => true,
			notify,
		},
	} as unknown as ExtensionCommandContext;
	await commands.get("rewind")!.handler("", ctx);
	expect(readFileSync(file, "utf8")).toBe("human draft");
	expect(notify).toHaveBeenCalledWith("Restored 1 file(s).", "info");
	const store = new CheckpointStore(harness.tempDir, join(agentDir, "checkpoints", "blobs"));
	expect(store.snapshot("draft.txt").hash).toBe(records[0].before.hash);
	const newSession = vi.fn(async () => ({ cancelled: false }));
	const clearStatusIndicator = vi.fn();
	const addChild = vi.fn();
	const requestRender = vi.fn();
	const restoreRememberedModel = vi.fn(async () => {});
	const clearCommand = (
		InteractiveMode.prototype as unknown as {
			handleClearCommand: (this: {
				clearStatusIndicator: () => void;
				runtimeHost: { newSession: () => Promise<{ cancelled: boolean }> };
				chatContainer: { addChild: (child: unknown) => void };
				session: { restoreRememberedModel: () => Promise<void> };
				ui: { requestRender: () => void };
			}) => Promise<void>;
		}
	).handleClearCommand;
	await clearCommand.call({
		clearStatusIndicator,
		runtimeHost: { newSession },
		chatContainer: { addChild },
		session: { restoreRememberedModel },
		ui: { requestRender },
	});
	expect(newSession).toHaveBeenCalledOnce();
	expect(clearStatusIndicator).toHaveBeenCalledOnce();
	expect(restoreRememberedModel).toHaveBeenCalledOnce();
	expect(requestRender).toHaveBeenCalledOnce();
});
