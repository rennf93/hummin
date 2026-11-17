import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { findLatestTodoSnapshot, formatTodoReminder, REMINDER_THRESHOLD, TODO_REMINDER_CUSTOM_TYPE } from "./todos.ts";

/**
 * TODO reminder: the `todo` tool (registered by a user-level extension) is
 * often created early in a session and then forgotten for long stretches, so
 * the model keeps working off a stale plan. After REMINDER_THRESHOLD turns
 * without a `todo` tool call, and while the last known list still has open
 * items, injects a short hidden reminder (display:false, customType
 * `todo-reminder`) naming the in_progress and first pending items and the
 * staleness, so the model updates the list or marks it done.
 *
 * Lifecycle-only: registers no tools, no commands, and talks to nothing. With
 * no todo list in the session window it injects nothing at all, so sessions
 * that never use the `todo` tool pay only the bounded backwards scan.
 */
export function createTodoReminderExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let turnsSinceTodoUpdate = 0;

		pi.on("session_start", () => {
			turnsSinceTodoUpdate = 0;
		});

		// Any observed `todo` call means the list is fresh: restart the neglect clock.
		pi.on("tool_call", (event) => {
			if (event.toolName === "todo") turnsSinceTodoUpdate = 0;
		});

		pi.on("before_agent_start", (_event, ctx) => {
			turnsSinceTodoUpdate += 1;
			const snapshot = findLatestTodoSnapshot(ctx.sessionManager.getEntries());
			// No list, or everything completed: nothing to remind about, nothing injected.
			if (!snapshot || snapshot.pending + snapshot.inProgress === 0) return undefined;
			if (turnsSinceTodoUpdate < REMINDER_THRESHOLD) return undefined;
			const content = formatTodoReminder(snapshot, turnsSinceTodoUpdate);
			return { message: { customType: TODO_REMINDER_CUSTOM_TYPE, content, display: false } };
		});
	};
}

export default createTodoReminderExtension();
