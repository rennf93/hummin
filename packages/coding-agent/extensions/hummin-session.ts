import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, resolveToCwd } from "@earendil-works/pi-coding-agent";
import { CheckpointStore, type FileCheckpoint, type FileSnapshot } from "./lib/checkpoints.ts";

const ENTRY = "hummin-file-checkpoint";

export default function humminSession(pi: ExtensionAPI): void {
	const pending = new Map<string, { path: string; before: FileSnapshot }>();
	const storeFor = (ctx: ExtensionContext) =>
		new CheckpointStore(ctx.cwd, join(getAgentDir(), "checkpoints", "blobs"));
	pi.on("session_start", (_event, ctx) => {
		const retain = new Set<string>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const checkpoint = entry.data as FileCheckpoint | undefined;
			if (checkpoint?.before?.hash) retain.add(checkpoint.before.hash);
			if (checkpoint?.after?.hash) retain.add(checkpoint.after.hash);
		}
		try {
			storeFor(ctx).prune(retain);
		} catch (error) {
			ctx.ui.notify(`Unable to prune old checkpoints: ${String(error)}`, "warning");
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (typeof event.input.path !== "string") return;
		try {
			const store = storeFor(ctx);
			const path = store.path(resolveToCwd(event.input.path, ctx.cwd));
			pending.set(event.toolCallId, { path, before: store.snapshot(path) });
		} catch (error) {
			ctx.ui.notify(`Rewind will not cover this edit: ${String(error)}`, "warning");
		}
	});
	pi.on("tool_result", (event, ctx) => {
		const saved = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!saved) return;
		try {
			if (
				typeof event.input.path !== "string" ||
				storeFor(ctx).path(resolveToCwd(event.input.path, ctx.cwd)) !== saved.path
			) {
				throw new Error("Tool path changed after checkpoint capture");
			}
			const after = storeFor(ctx).snapshot(saved.path);
			if (after.hash !== saved.before.hash || after.mode !== saved.before.mode) {
				pi.appendEntry(ENTRY, { version: 1, ...saved, after } satisfies FileCheckpoint);
			}
		} catch (error) {
			ctx.ui.notify(`Unable to finish checkpoint: ${String(error)}`, "warning");
		}
	});
	pi.on("agent_end", () => {
		pending.clear();
	});
	pi.registerCommand("rewind", {
		description: "Restore tracked edits and/or conversation to an earlier prompt",
		category: "Session",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Stop the current response before rewinding.", "warning");
				return;
			}
			const branch = ctx.sessionManager.getBranch();
			const leaf = ctx.sessionManager.getLeafId();
			const prompts = branch
				.flatMap((entry, index) => {
					if (entry.type !== "message" || entry.message.role !== "user") return [];
					const content = entry.message.content;
					const text =
						typeof content === "string"
							? content
							: content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n");
					return [{ id: entry.id, index, text }];
				})
				.reverse();
			if (!prompts.length) {
				ctx.ui.notify("No earlier prompts in this branch.", "info");
				return;
			}
			const labels = prompts.map((prompt) => `${prompt.id}  ${prompt.text.replace(/\s+/g, " ").slice(0, 90)}`);
			const selected = await ctx.ui.select("Rewind to before which prompt?", labels);
			if (!selected) return;
			const prompt = prompts[labels.indexOf(selected)];
			if (!prompt) return;
			const mode = await ctx.ui.select("Restore", ["Files and conversation", "Files only", "Conversation only"]);
			if (!mode) return;
			try {
				if (ctx.sessionManager.getLeafId() !== leaf)
					throw new Error("Session changed during rewind; select a checkpoint again");
				if (mode !== "Conversation only") {
					const records = branch
						.slice(prompt.index)
						.flatMap((entry) =>
							entry.type === "custom" && entry.customType === ENTRY ? [entry.data as FileCheckpoint] : [],
						);
					const store = storeFor(ctx);
					const changes = store.prepare(records);
					if (
						!(await ctx.ui.confirm(
							"Restore tracked files?",
							`${changes.map((change) => `${change.after.hash === null ? "Remove created file" : "Restore"}: ${change.path}`).join("\n") || "No tracked file changes."}\n\nCovers edit/write only. Shell commands, subagents and external effects are not restored. Stop background writers first.`,
						))
					)
						return;
					if (!ctx.isIdle()) throw new Error("Agent resumed during rewind; stop it and retry");
					if (ctx.sessionManager.getLeafId() !== leaf)
						throw new Error("Session changed during rewind; select a checkpoint again");
					const restored = store.restore(records, (change) => pi.appendEntry(ENTRY, change));
					ctx.ui.notify(`Restored ${restored.length} file(s).`, "info");
				}
				if (mode !== "Files only") {
					const result = await ctx.navigateTree(prompt.id, { summarize: false });
					if (result.cancelled)
						ctx.ui.notify("Conversation rewind cancelled; any restored files remain restored.", "warning");
					else ctx.ui.setEditorText(prompt.text);
				}
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		},
	});
}
