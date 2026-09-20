import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { StatuslineSettings } from "../../../core/settings-manager.ts";
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
		if (entry.type === "usage") {
			addUsageToTotals(usage, entry.usage as Usage);
			return undefined;
		}
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

	/** One left-aligned footer row: groups joined by dim separators. */
	private joinGroups(groups: string[]): string {
		return groups.filter((group) => group.length > 0).join(theme.fg("dim", " | "));
	}

	/** Fit a left and right block on one width, right block pinned to the edge; left truncates first. */
	private alignLeftRight(left: string, right: string, width: number): string {
		const rightWidth = visibleWidth(right);
		if (visibleWidth(left) + rightWidth <= width) {
			return left + " ".repeat(width - visibleWidth(left) - rightWidth) + right;
		}
		if (rightWidth >= width) return truncateToWidth(right, width, "...");
		const truncatedLeft = truncateToWidth(left, width - rightWidth, "...");
		const padding = " ".repeat(Math.max(0, width - visibleWidth(truncatedLeft) - rightWidth));
		return truncatedLeft + padding + right;
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

		const cwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const gitStatus = this.footerData.getGitStatus();
		const branch = this.footerData.getGitBranch();
		const repoName = this.footerData.getGitRepoName();

		const extensionStatuses = this.footerData.getExtensionStatuses();

		// hummin: custom statusline layout. When `statusline` has at least one non-empty
		// side, the fixed two-row content is replaced by the user-ordered segments.
		const statusline: StatuslineSettings | undefined = this.session.settingsManager?.getStatusline?.();
		const customStatusline =
			statusline !== undefined && ((statusline.left?.length ?? 0) > 0 || (statusline.right?.length ?? 0) > 0);

		// Row 1: dir | repo | branch   |   (provider) + model
		const idParts: string[] = [theme.fg("dim", cwd)];
		if (repoName) idParts.push(repoName);
		if (branch) {
			const dirty =
				gitStatus && (gitStatus.staged > 0 || gitStatus.modified > 0 || gitStatus.untracked > 0) ? "*" : "";
			idParts.push(theme.fg("accent", `${branch}${dirty}`));
		}
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) idParts.push(sessionName);
		const idLine = this.joinGroups(idParts);

		const modelName = state.model?.id || "no-model";
		const providerName = state.model
			? (this.session.modelRuntime.getProvider(state.model.provider)?.name ?? state.model.provider)
			: undefined;
		const modelParts: string[] = [];
		if (providerName) modelParts.push(theme.fg("dim", `(${providerName})`));
		modelParts.push(theme.fg("accent", modelName));
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			modelParts.push(theme.fg("dim", thinkingLevel === "off" ? "no thinking" : thinkingLevel));
		}
		const modelLine = `${theme.fg("dim", "·")} ${modelParts.join(theme.fg("dim", " + "))}`;

		// Row 2: diff | git | tokens   |   ctx bar
		const statGroups: string[] = [];
		const queueCount = this.session.pendingMessageCount + this.compactionQueueCount;
		if (queueCount > 0) statGroups.push(`${theme.fg("dim", "queue")} ${theme.fg("accent", String(queueCount))}`);

		// Cumulative diff made by the agent this session (from edit/write tool patches)
		let diffText = "";
		if (sessionDiff.added > 0 || sessionDiff.removed > 0) {
			const diffParts: string[] = [];
			if (sessionDiff.added > 0) diffParts.push(theme.fg("toolDiffAdded", `+${formatTokens(sessionDiff.added)}`));
			if (sessionDiff.removed > 0)
				diffParts.push(theme.fg("toolDiffRemoved", `-${formatTokens(sessionDiff.removed)}`));
			diffText = diffParts.join(" ");
			statGroups.push(`${theme.fg("dim", "diff")} ${diffText}`);
		}

		// Git working-tree state (includes changes made outside the agent)
		let gitText = "";
		if (gitStatus) {
			const gitParts: string[] = [];
			if (gitStatus.staged > 0) gitParts.push(theme.fg("toolDiffAdded", `+${gitStatus.staged}`));
			if (gitStatus.modified > 0) gitParts.push(theme.fg("warning", `~${gitStatus.modified}`));
			if (gitStatus.untracked > 0) gitParts.push(theme.fg("dim", `?${gitStatus.untracked}`));
			if (gitStatus.ahead) gitParts.push(theme.fg("accent", `↑${gitStatus.ahead}`));
			if (gitStatus.behind) gitParts.push(theme.fg("accent", `↓${gitStatus.behind}`));
			if (gitParts.length > 0) {
				gitText = gitParts.join(" ");
				statGroups.push(`${theme.fg("dim", "git")} ${gitText}`);
			}
		}

		const tokenParts: string[] = [];
		if (usageTotals.input) tokenParts.push(`${theme.fg("dim", "in")} ${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) tokenParts.push(`${theme.fg("dim", "out")} ${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) tokenParts.push(`${theme.fg("dim", "rd")} ${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) tokenParts.push(`${theme.fg("dim", "wr")} ${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			tokenParts.push(`${theme.fg("dim", "hit")} ${latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		const pricedModel = state.model && Object.values(state.model.cost ?? {}).some((rate) => rate > 0);
		let costText = "";
		if (usageTotals.cost || usingSubscription || pricedModel) {
			costText = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			tokenParts.push(costText);
		}
		if (tokenParts.length > 0) statGroups.push(tokenParts.join(theme.fg("dim", " · ")));
		const statsLine = this.joinGroups(statGroups);

		// Context meter: ctx [████░░░░░░] 3.2% — unchanged size, pinned to the right edge.
		const autoTag = this.autoCompactEnabled ? " auto" : "";
		const barCells = 10;
		const filled = Math.max(0, Math.min(barCells, Math.round((contextPercentValue / 100) * barCells)));
		const bar = "█".repeat(filled) + "░".repeat(barCells - filled);
		const meterColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "accent";
		const contextValue =
			contextPercent === "?"
				? `${theme.fg("dim", "?")}/${formatTokens(contextWindow)}`
				: `${theme.fg(meterColor, bar)} ${theme.fg("dim", `${contextPercent}%${autoTag}`)}`;
		const contextLine = `${theme.fg("dim", "·")} ${theme.fg("dim", "ctx")} ${contextValue}`;

		let lines: string[];
		if (customStatusline && statusline) {
			// Custom layout: one row of user-ordered segments. Known tokens resolve from
			// the same data as the fixed rows; unknown tokens render dim as-is.
			const segmentText = (token: string): string => {
				switch (token) {
					case "dir":
						return theme.fg("dim", cwd);
					case "repo":
						return repoName ?? "";
					case "branch": {
						if (!branch) return "";
						const dirty =
							gitStatus && (gitStatus.staged > 0 || gitStatus.modified > 0 || gitStatus.untracked > 0)
								? "*"
								: "";
						return theme.fg("accent", `${branch}${dirty}`);
					}
					case "model":
						return theme.fg("accent", modelName);
					case "provider":
						return providerName ? theme.fg("dim", `(${providerName})`) : "";
					case "ctx":
						return `${theme.fg(meterColor, `${contextPercent}%`)}${
							contextWindow ? theme.fg("dim", `/${formatTokens(contextWindow)}`) : ""
						}`;
					case "tokens":
						return tokenParts.join(theme.fg("dim", " · "));
					case "cost":
						return costText;
					case "queue":
						return queueCount > 0 ? `${theme.fg("dim", "queue")} ${theme.fg("accent", String(queueCount))}` : "";
					case "background":
						return sanitizeStatusText(extensionStatuses.get("bg") ?? "");
					case "sandbox":
						return sanitizeStatusText(extensionStatuses.get("sandbox") ?? "");
					case "mcp":
						return sanitizeStatusText(extensionStatuses.get("mcp") ?? "");
					case "git":
						return gitText ? `${theme.fg("dim", "git")} ${gitText}` : "";
					case "diff":
						return diffText ? `${theme.fg("dim", "diff")} ${diffText}` : "";
					default:
						// Unknown token: render dim as-is (documented tolerant behavior)
						return theme.fg("dim", token);
				}
			};
			// Custom sides join with the subtle dim middot (like the stats row):
			// with many segments on one line, " | " reads as pipe soup.
			const resolveSide = (tokens: string[] | undefined): string =>
				(tokens ?? [])
					.map(segmentText)
					.filter((part) => part.length > 0)
					.join(theme.fg("dim", " · "));
			lines = [this.alignLeftRight(resolveSide(statusline.left), resolveSide(statusline.right), width), ""];
		} else {
			lines = [
				this.alignLeftRight(idLine, modelLine, width),
				"",
				this.alignLeftRight(statsLine, contextLine, width),
			];
		}

		// Add extension statuses on a single line, sorted by key alphabetically.
		// The "todo" key is excluded: it renders natively as a styled segment below.
		const sortedStatuses = Array.from(extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.filter(([key]) => key !== "todo")
			.map(([, text]) => sanitizeStatusText(text));
		const todoSummary = this.footerData.getTodoSummary();
		if (todoSummary) {
			const [counts, ...rest] = sanitizeStatusText(todoSummary).split(" · ");
			const detail = rest.length > 0 ? ` ${theme.fg("dim", `· ${rest.join(" · ")}`)}` : "";
			sortedStatuses.unshift(`${theme.fg("dim", "TODOs")} ${theme.fg("accent", counts)}${detail}`);
		}
		if (sortedStatuses.length > 0) {
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
