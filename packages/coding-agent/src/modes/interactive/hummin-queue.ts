import { type Component, MouseRegion, TruncatedText } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { type QueuedMessageEntry, QueueManagerComponent } from "./components/queue-manager.ts";
import { queuedMessageToEditorText } from "./queue-attachments.ts";
import { theme } from "./theme/theme.ts";

interface CompactionQueuedMessageRef {
	text: string;
	mode: "steer" | "followUp";
}

/** Class internals the queue manager acts on, passed in explicitly by InteractiveMode. */
export interface QueueManagerContext {
	getSession: () => AgentSession;
	getCompactionQueuedMessages: () => CompactionQueuedMessageRef[];
	getEditorText: () => string;
	setEditorText: (text: string) => void;
	/** Register a materialized image file so submit re-attaches it instead of sending the path as text. */
	trackImageFile: (path: string) => void;
	showSelector: (create: (done: () => void) => { component: Component; focus: Component }) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	updatePendingMessagesDisplay: () => void;
	requestRender: () => void;
}

/**
 * Remove every session-queued message and return their editor text, steering and follow-up separately.
 * Throws when an attachment cannot be materialized; in that case no message has been removed.
 */
export function takeSessionQueuedMessages(
	session: AgentSession,
	onImageFile?: (path: string) => void,
): { steering: string[]; followUp: string[] } {
	// Materialize every attachment before mutating either queue. A failed write leaves messages pending.
	const snapshots = (["steering", "followUp"] as const).flatMap((kind) =>
		session.getQueuedUserMessages(kind).map((message, index) => ({
			kind,
			message,
			index,
			text: queuedMessageToEditorText(message, onImageFile),
		})),
	);
	const steering: string[] = [];
	const followUp: string[] = [];
	for (const entry of snapshots) {
		if (session.removeQueuedMessage(entry.kind, entry.index, entry.message) !== undefined) {
			(entry.kind === "steering" ? steering : followUp).push(entry.text);
		}
	}
	return { steering, followUp };
}

/** The pending-queue hint line; clicking it opens the queue manager. */
export function createQueueHint(dequeueHint: string, openQueueManager: () => void): Component {
	const hintText = theme.fg("dim", `↳ ${dequeueHint} edits all · click here or /queue to manage individually`);
	return new MouseRegion(new TruncatedText(hintText, 1, 0), (event) => {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		if (event.type === "click") openQueueManager();
		return { handled: true };
	});
}

export function showQueueManager(ctx: QueueManagerContext): void {
	const entries: Array<QueuedMessageEntry & { restoreText: () => string; remove: () => boolean }> = [];
	for (const kind of ["steering", "followUp"] as const) {
		for (const [index, message] of ctx.getSession().getQueuedUserMessages(kind).entries()) {
			const content =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			entries.push({
				kind,
				index,
				text: content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join(""),
				imageCount: content.filter((part) => part.type === "image").length,
				restoreText: () => queuedMessageToEditorText(message, ctx.trackImageFile),
				remove: () => ctx.getSession().removeQueuedMessage(kind, index, message) !== undefined,
			});
		}
		for (const message of ctx
			.getCompactionQueuedMessages()
			.filter((item) => item.mode === (kind === "steering" ? "steer" : "followUp"))) {
			entries.push({
				kind,
				index: entries.length,
				text: message.text,
				restoreText: () => message.text,
				remove: () => {
					const compactionQueue = ctx.getCompactionQueuedMessages();
					const index = compactionQueue.indexOf(message);
					if (index < 0) return false;
					compactionQueue.splice(index, 1);
					return true;
				},
			});
		}
	}
	if (entries.length === 0) {
		ctx.showStatus("No queued messages");
		return;
	}

	ctx.showSelector((done) => {
		const component = new QueueManagerComponent(
			entries,
			(action, entry) => {
				const selected = entries.find((item) => item === entry);
				if (!selected) return;
				try {
					const text = action === "restore" ? selected.restoreText() : undefined;
					if (selected.remove()) {
						if (text !== undefined)
							ctx.setEditorText([text, ctx.getEditorText()].filter((part) => part.trim()).join("\n\n"));
					} else {
						ctx.showStatus("That message has already left the queue");
					}
				} catch (error) {
					ctx.showError(error instanceof Error ? error.message : String(error));
				}
				done();
				ctx.updatePendingMessagesDisplay();
				ctx.requestRender();
				if (
					action === "delete" &&
					ctx.getSession().pendingMessageCount + ctx.getCompactionQueuedMessages().length > 0
				)
					showQueueManager(ctx);
			},
			() => {
				done();
				ctx.requestRender();
			},
		);
		return { component, focus: component };
	});
}
