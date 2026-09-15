import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startRemoteControl } from "./lib/remote.ts";

function visibleText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content.slice(-6000);
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.slice(-6000);
}

export default function humminRemote(pi: ExtensionAPI): void {
	let remote: Awaited<ReturnType<typeof startRemoteControl>> | undefined;
	let context: ExtensionContext | undefined;
	let partial: AgentMessage | undefined;
	let waiting: string | undefined;
	let starting = false;
	let closed = false;
	pi.on("message_update", (event, ctx) => {
		partial = event.message;
		context = ctx;
	});
	pi.on("message_end", (_event, ctx) => {
		partial = undefined;
		context = ctx;
	});
	pi.on("model_select", (_event, ctx) => {
		context = ctx;
	});
	pi.on("ui_prompt_start", (event) => {
		waiting = event.title ?? event.kind;
	});
	pi.on("ui_prompt_end", () => {
		waiting = undefined;
	});
	pi.on("session_shutdown", async () => {
		closed = true;
		await remote?.close();
		remote = undefined;
	});
	pi.registerCommand("remote-control", {
		description: "Start a browser control endpoint; use stop to disconnect",
		category: "Session",
		handler: async (args, ctx) => {
			if (args.trim() === "stop") {
				await remote?.close();
				remote = undefined;
				ctx.ui.setStatus("remote-control", undefined);
				ctx.ui.notify("Remote control stopped.", "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /remote-control [stop]", "warning");
				return;
			}
			if (starting) return;
			context = ctx;
			if (!remote) {
				starting = true;
				try {
					remote = await startRemoteControl({
						state: () => {
							const current = context!;
							const messages = current.sessionManager
								.getBranch()
								.flatMap((entry) =>
									entry.type === "message"
										? [{ role: entry.message.role, text: visibleText(entry.message) }]
										: [],
								)
								.slice(-60);
							if (partial) messages.push({ role: partial.role, text: visibleText(partial) });
							return {
								sessionId: current.sessionManager.getSessionId(),
								name: pi.getSessionName() ?? "Session",
								model: current.model ? `${current.model.provider}/${current.model.id}` : "No model",
								status: waiting ? `Waiting in terminal: ${waiting}` : current.isIdle() ? "Idle" : "Working",
								messages,
							};
						},
						prompt: (text) => {
							if (waiting) throw new Error("Answer the pending approval dialog in the terminal first");
							pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
						},
						abort: () => context?.abort(),
					});
					if (closed) {
						await remote.close();
						remote = undefined;
						return;
					}
				} finally {
					starting = false;
				}
			}
			ctx.ui.setStatus("remote-control", "remote control on");
			ctx.ui.notify(
				`Remote control: ${remote.url}\nLoopback only. For another device, forward port ${remote.port} over SSH and open this URL there. /remote-control stop disconnects clients.`,
				"info",
			);
		},
	});
}
