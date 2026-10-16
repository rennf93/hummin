import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { consumeBackgroundMigrationChoice, setBackgroundMigrationChoice } from "../../core/session-migration.ts";

/** The only fields of a compaction-queued message this module reads. */
type CompactionQueued = { text: string; mode: "steer" | "followUp" };

type MigratedMessage = { content: string | (TextContent | ImageContent)[]; deliverAs: "steer" | "followUp" };

interface QueuedForMigration<T extends CompactionQueued> {
	queued: MigratedMessage[];
	compaction: T[];
}

export interface SessionClearDeps<T extends CompactionQueued> {
	session: AgentSession;
	compactionQueuedMessages: readonly T[];
	footerDataProvider: Pick<ReadonlyFooterDataProvider, "getExtensionStatuses">;
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface SessionClearMigration<T extends CompactionQueued> {
	migrate: boolean;
	successMessage: string;
	queued: QueuedForMigration<T>;
	/** Clears the migration choice once the session switch has run. */
	releaseChoice: () => void;
}

/** Everything queued on the CURRENT session that a migrated clear should carry over. */
function collectQueuedForMigration<T extends CompactionQueued>(deps: SessionClearDeps<T>): QueuedForMigration<T> {
	return {
		queued: [
			...deps.session.getQueuedUserMessages("steering").map((message) => ({
				content: message.content as string | (TextContent | ImageContent)[],
				deliverAs: "followUp" as const,
			})),
			...deps.session.getQueuedUserMessages("followUp").map((message) => ({
				content: message.content as string | (TextContent | ImageContent)[],
				deliverAs: "followUp" as const,
			})),
		],
		compaction: [...deps.compactionQueuedMessages],
	};
}

/** Human-readable list of work that a clear would interrupt; empty when idle. */
function describeRunningWork<T extends CompactionQueued>(deps: SessionClearDeps<T>): string[] {
	const running: string[] = [];
	if (deps.session.isStreaming) running.push("active response");
	if (deps.session.isBashRunning) running.push("bash command");
	const queuedCount = deps.session.pendingMessageCount + deps.compactionQueuedMessages.length;
	if (queuedCount > 0) running.push(`${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`);
	const background = deps.footerDataProvider.getExtensionStatuses().get("bg");
	if (background) running.push(background);
	return running;
}

/** Ask whether running work migrates, then record the choice for the session switch. Undefined means the user cancelled the clear. */
export async function beginSessionClear<T extends CompactionQueued>(
	deps: SessionClearDeps<T>,
): Promise<SessionClearMigration<T> | undefined> {
	// Snapshot before the switch: queued messages live on the outgoing
	// session and would otherwise be dropped with it.
	const queued = collectQueuedForMigration(deps);
	const running = describeRunningWork(deps);
	let migrate = false;
	if (running.length > 0) {
		const choice = await deps.showExtensionSelector(
			`Running work: ${running.join(", ")}. Keep it running in the new session?`,
			["Continue running (migrate to new session)", "Abort all"],
		);
		if (choice === undefined) return undefined; // escape cancels the clear
		migrate = choice.startsWith("Continue running");
	}
	setBackgroundMigrationChoice(migrate ? "migrate" : "abort");
	return {
		migrate,
		successMessage: migrate ? "✓ New session started (running work migrated)" : "✓ New session started",
		queued,
		releaseChoice: () => {
			consumeBackgroundMigrationChoice();
		},
	};
}

/** Re-deliver queued messages into the fresh session after a migrated clear. */
export async function restoreQueuedAfterMigration<T extends CompactionQueued>(
	session: AgentSession,
	migration: SessionClearMigration<T>,
): Promise<void> {
	if (!migration.migrate) return;
	const messages: MigratedMessage[] = [
		...migration.queued.compaction.map((entry) => ({
			content: entry.text as string | (TextContent | ImageContent)[],
			deliverAs: entry.mode,
		})),
		...migration.queued.queued,
	];
	for (const message of messages) {
		try {
			await session.sendUserMessage(message.content, { deliverAs: message.deliverAs });
		} catch {
			// A message that cannot re-deliver (e.g. no model) must not abort the
			// remaining migrations; the user sees the fresh session either way.
		}
	}
}
