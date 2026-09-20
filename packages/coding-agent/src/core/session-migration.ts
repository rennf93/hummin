/**
 * Cross-boundary flag for background-process migration on session switches.
 *
 * When the interactive mode replaces a session (/clear, app.session.new) and the
 * user chooses "continue running", background jobs (tasks, monitors) must keep
 * running under the incoming session instead of being killed by the outgoing
 * session's `session_shutdown` handlers. The choice is made in the core UI but
 * consumed inside extension code, which cannot be imported by core - so the
 * flag rides on `globalThis` under a registered symbol. Both sides reference
 * the SAME symbol key string:
 *
 * - writer: `src/core/session-migration.ts` (this file)
 * - reader: `extensions/lib/processes.ts` (`migrationChoice()`)
 */

const MIGRATION_KEY = Symbol.for("hummin.background.migration");

export type BackgroundMigrationChoice = "migrate" | "abort";

/** Record the user's clear-session choice for the upcoming session switch. */
export function setBackgroundMigrationChoice(choice: BackgroundMigrationChoice): void {
	(globalThis as Record<symbol, unknown>)[MIGRATION_KEY] = choice;
}

/** Read and clear the choice; switches without a dialog run with "abort" semantics. */
export function consumeBackgroundMigrationChoice(): BackgroundMigrationChoice {
	const global = globalThis as Record<symbol, unknown>;
	const choice = global[MIGRATION_KEY] === "migrate" ? "migrate" : "abort";
	global[MIGRATION_KEY] = undefined;
	return choice;
}
