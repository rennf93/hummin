import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { countDiffStat, type DiffStat } from "./diff.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private compactionQueueCount = 0;
	/** Cached per-toolCall diff stats so re-renders don't re-count patches. */
	private diffStatCache = new Map<string, DiffStat>();
	/** Aggregated stats for all entries except the last; recomputed only when the entry set grows. */
	private cachedPrefix:
		| {
				entryCount: number;
				firstEntry: unknown;
				usage: UsageTotals;
				diff: DiffStat;
				cacheHitRate: number | undefined;
		  }
		| undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setCompactionQueueCount(count: number): void {
		this.compactionQueueCount = count;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/** Cached per-toolCall diff stat, or undefined when the result carries no diff. */
	private getToolDiffStat(message: { toolCallId: string; details?: unknown }): DiffStat | undefined {
		const details = message.details as { diff?: unknown; added?: unknown; removed?: unknown } | undefined;
		// edit stores a display diff; write stores precomputed counts
		if (typeof details?.added === "number" && typeof details.removed === "number") {
			return { added: details.added, removed: details.removed };
		}
		if (typeof details?.diff !== "string" || details.diff === "") return undefined;
		const cached = this.diffStatCache.get(message.toolCallId);
		if (cached) return cached;
		const stat = countDiffStat(details.diff);
		this.diffStatCache.set(message.toolCallId, stat);
		return stat;
	}

	/** Aggregate usage/diff stats from a single session entry. */
	private aggregateEntry(
		entry: { type: string; message?: unknown; usage?: unknown },
		usage: UsageTotals,
		diff: DiffStat,
	): number | undefined {
		const message = entry.message as
			| { role?: string; usage?: Usage; details?: unknown; toolCallId?: string }
			| undefined;
		if (entry.type === "message" && message?.role === "assistant") {
			const msgUsage = message.usage as Usage;
			addUsageToTotals(usage, msgUsage);
			const latestPromptTokens = msgUsage.input + msgUsage.cacheRead + msgUsage.cacheWrite;
			return latestPromptTokens > 0 ? (msgUsage.cacheRead / latestPromptTokens) * 100 : undefined;
		}
		if (entry.type === "message" && message?.role === "toolResult") {
			if (message.usage) {
				addUsageToTotals(usage, message.usage);
			}
			const stat = this.getToolDiffStat({ toolCallId: message.toolCallId ?? "", details: message.details });
			if (stat) {
				diff.added += stat.added;
				diff.removed += stat.removed;
			}
		}
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(usage, entry.usage as Usage);
		}
		return undefined;
	}

	/**
	 * Compute session-wide stats. All entries except the last are cached (entries only grow, and
	 * older entries never change); the last entry is folded in fresh each render because its
	 * usage mutates while an assistant message streams.
	 */
	private computeSessionStats() {
		const entries = this.session.sessionManager.getEntries();
		const prefixCount = Math.max(0, entries.length - 1);
		if (
			!this.cachedPrefix ||
			this.cachedPrefix.entryCount !== prefixCount ||
			entries[0] !== this.cachedPrefix.firstEntry
		) {
			const usage = createUsageTotals();
			const diff: DiffStat = { added: 0, removed: 0 };
			let cacheHitRate: number | undefined;
			for (let i = 0; i < prefixCount; i++) {
				const hitRate = this.aggregateEntry(
					entries[i] as { type: string; message?: unknown; usage?: unknown },
					usage,
					diff,
				);
				if (hitRate !== undefined) cacheHitRate = hitRate;
			}
			this.cachedPrefix = { entryCount: prefixCount, firstEntry: entries[0], usage, diff, cacheHitRate };
		}

		const usageTotals = { ...this.cachedPrefix.usage };
		const sessionDiff: DiffStat = { ...this.cachedPrefix.diff };
		let latestCacheHitRate = this.cachedPrefix.cacheHitRate;
		if (entries.length > 0) {
			const hitRate = this.aggregateEntry(
				entries[entries.length - 1] as { type: string; message?: unknown; usage?: unknown },
				usageTotals,
				sessionDiff,
			);
			if (hitRate !== undefined) latestCacheHitRate = hitRate;
		}
		return { usageTotals, sessionDiff, latestCacheHitRate };
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const { usageTotals, sessionDiff, latestCacheHitRate } = this.computeSessionStats();

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available, with a dirty marker when the working tree has changes
		const gitStatus = this.footerData.getGitStatus();
		const branch = this.footerData.getGitBranch();
		if (branch) {
			const dirty =
				gitStatus && (gitStatus.staged > 0 || gitStatus.modified > 0 || gitStatus.untracked > 0) ? "*" : "";
			pwd = `${pwd} (${branch}${dirty})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats: labeled segments on the left (dim label, bright value),
		// context meter, model on the right.
		const statsParts: Array<{ label: string; value: string }> = [];
		const queueCount = this.session.pendingMessageCount + this.compactionQueueCount;
		if (queueCount > 0) statsParts.push({ label: "queue", value: theme.fg("accent", String(queueCount)) });

		// Cumulative diff made by the agent this session (from edit/write tool patches)
		if (sessionDiff.added > 0 || sessionDiff.removed > 0) {
			const diffParts: string[] = [];
			if (sessionDiff.added > 0) diffParts.push(theme.fg("toolDiffAdded", `+${formatTokens(sessionDiff.added)}`));
			if (sessionDiff.removed > 0)
				diffParts.push(theme.fg("toolDiffRemoved", `-${formatTokens(sessionDiff.removed)}`));
			statsParts.push({ label: "diff", value: diffParts.join(" ") });
		}

		// Git working-tree state (includes changes made outside the agent)
		if (gitStatus) {
			const gitParts: string[] = [];
			if (gitStatus.staged > 0) gitParts.push(theme.fg("toolDiffAdded", `+${gitStatus.staged}`));
			if (gitStatus.modified > 0) gitParts.push(theme.fg("warning", `~${gitStatus.modified}`));
			if (gitStatus.untracked > 0) gitParts.push(theme.fg("dim", `?${gitStatus.untracked}`));
			if (gitStatus.ahead) gitParts.push(theme.fg("accent", `↑${gitStatus.ahead}`));
			if (gitStatus.behind) gitParts.push(theme.fg("accent", `↓${gitStatus.behind}`));
			if (gitParts.length > 0) statsParts.push({ label: "git", value: gitParts.join(" ") });
		}

		if (usageTotals.input) statsParts.push({ label: "in", value: formatTokens(usageTotals.input) });
		if (usageTotals.output) statsParts.push({ label: "out", value: formatTokens(usageTotals.output) });
		if (usageTotals.cacheRead) statsParts.push({ label: "rd", value: formatTokens(usageTotals.cacheRead) });
		if (usageTotals.cacheWrite) statsParts.push({ label: "wr", value: formatTokens(usageTotals.cacheWrite) });
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push({ label: "hit", value: `${latestCacheHitRate.toFixed(1)}%` });
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		const pricedModel = state.model && Object.values(state.model.cost ?? {}).some((rate) => rate > 0);
		if (usageTotals.cost || usingSubscription || pricedModel) {
			statsParts.push({
				label: "",
				value: `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
			});
		}

		// Context meter: ctx [████░░░░░░] 3.2%
		const autoTag = this.autoCompactEnabled ? " auto" : "";
		const barCells = 10;
		const filled = Math.max(0, Math.min(barCells, Math.round((contextPercentValue / 100) * barCells)));
		const bar = "█".repeat(filled) + "░".repeat(barCells - filled);
		const meterColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "accent";
		const contextValue =
			contextPercent === "?"
				? `${theme.fg("dim", "?")}/${formatTokens(contextWindow)}`
				: `${theme.fg(meterColor, bar)} ${theme.fg("dim", `${contextPercent}%${autoTag}`)}`;
		statsParts.push({ label: "ctx", value: contextValue });

		const renderedSegments = statsParts.map(({ label, value }) =>
			label ? `${theme.fg("dim", label)} ${value}`.trim() : value,
		);
		const meterBlock = renderedSegments.join(theme.fg("dim", " · "));

		// Right side: provider (when ambiguous), model, thinking level
		const modelName = state.model?.id || "no-model";
		const rightParts: string[] = [];
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			// Provider display name (engine - host) when registered; id fallback.
			const providerName = this.session.modelRuntime.getProvider(state.model.provider)?.name ?? state.model.provider;
			rightParts.push(theme.fg("dim", `(${providerName})`));
		}
		rightParts.push(theme.fg("accent", modelName));
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightParts.push(theme.fg("dim", thinkingLevel === "off" ? "no thinking" : thinkingLevel));
		}
		const rightSide = rightParts.join(theme.fg("dim", " · "));

		const minPadding = 2;
		const leftWidth = visibleWidth(meterBlock);
		const rightWidth = visibleWidth(rightSide);

		let statsLine: string;
		if (leftWidth + minPadding + rightWidth <= width) {
			statsLine = meterBlock + " ".repeat(width - leftWidth - rightWidth) + rightSide;
		} else {
			const availableForRight = width - leftWidth - minPadding;
			const truncatedRight = availableForRight > 0 ? truncateToWidth(rightSide, availableForRight, "") : "";
			const truncatedRightWidth = visibleWidth(truncatedRight);
			const padding = " ".repeat(Math.max(0, width - leftWidth - truncatedRightWidth));
			statsLine = meterBlock + padding + truncatedRight;
			if (leftWidth > width) {
				statsLine = truncateToWidth(meterBlock, width, "...");
			}
		}

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, statsLine];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
