/**
 * hummin-remote: the /remote-control command. Starts the remote console
 * server (lib/remote-console) on the live session and keeps the terminal
 * surface honest: the status line, the usage notify, and the console-tracked
 * queue (what the console sent with which delivery mode). Appearance prefs
 * live browser-side; this wrapper owns nothing about them.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveSettings, resolveRemoteConsoleConfig, startRemoteConsole, type RemoteConsoleHandle } from "./lib/remote-console/index.ts";

export default function humminRemote(pi: ExtensionAPI): void {
	let handle: RemoteConsoleHandle | undefined;
	let context: ExtensionContext | undefined;
	let waiting: string | undefined;
	let starting = false;
	let closed = false;

	// Keep enough context to send prompts and judge busyness; the console
	// module subscribes the same events for its own mapping.
	pi.on("message_update", (_event, ctx) => {
		context = ctx;
	});
	pi.on("agent_settled", (_event, ctx) => {
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
		await handle?.close();
		handle = undefined;
	});

	pi.registerCommand("remote-control", {
		description: "Start the browser remote console; use stop to disconnect",
		category: "Session",
		handler: async (args, ctx) => {
			if (args.trim() === "stop") {
				await handle?.close();
				handle = undefined;
				ctx.ui.setStatus("remote-control", undefined);
				ctx.ui.notify("Remote console stopped.", "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /remote-control [stop]", "warning");
				return;
			}
			if (starting) return;
			context = ctx;
			const config = resolveRemoteConsoleConfig(effectiveSettings(pi), process.env);
			if (config.disabled) {
				ctx.ui.notify("Remote console is disabled (HUMMIN_REMOTE=off).", "info");
				return;
			}
			if (handle) {
				ctx.ui.notify(`Remote console already running: ${handle.publicUrl ?? handle.url}`, "info");
				return;
			}
			starting = true;
			try {
				handle = await startRemoteConsole(pi, {
					context: ctx,
					sendPrompt: (text, deliverAs) => {
						if (waiting) throw new Error("Answer the pending dialog in the terminal first");
						// Record before sending: once sent, a busy agent may consume
						// the message immediately and the item is no longer queued.
						const busy = context ? !context.isIdle() : false;
						if (busy) handle?.trackQueued(text, deliverAs);
						pi.sendUserMessage(text, { deliverAs, expandPromptTemplates: false });
					},
					abort: () => context?.abort(),
				});
			} finally {
				starting = false;
			}
			if (closed) {
				await handle.close();
				handle = undefined;
				return;
			}
			ctx.ui.setStatus("remote-control", "remote console on");
			ctx.ui.notify(
				handle.publicUrl !== undefined
					? `Remote console: ${handle.publicUrl}\nServed through the proxy at ${new URL(handle.publicUrl).host}; local: ${handle.url}. /remote-control stop disconnects clients.`
					: config.lan
						? `Remote console: ${handle.url}\nBound beyond loopback (${config.host}): anyone on this network holding the token can control this session. /remote-control stop disconnects clients.`
						: `Remote console: ${handle.url}\nLoopback only. For another device, forward port ${handle.port} over SSH and open this URL there. /remote-control stop disconnects clients.`,
				"info",
			);
		},
	});
}
