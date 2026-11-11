/**
 * components/Header: the active host's header bar. Left: the session name
 * (falling back to the host label) and the run status as a dot plus a
 * sentence-case word (shimmering while the agent works; a running compaction
 * or memory fold takes the word's place, a failed one shows in the bad tone).
 * Right: live tok/s, the context meter (a scaleX fill and a rolling percent,
 * plus "auto" when auto-compaction is on), session cost, the todo chip, model
 * and thinking level as quiet metadata, the preset quick-switch as a
 * sliding-pill segmented control that drives the appearance store, the
 * session stats popover button and the button that opens the full appearance
 * panel. Every hummin-specific datum is optional and renders nothing when the
 * host did not publish it. While the stream is not connected the status word
 * names the connection state (no shimmer) and the last run values (tok/s,
 * activity, context, cost) stop posing as live: tok/s and the activity label
 * are dropped, the rest is dimmed. Metadata drops by header width through
 * container queries (styles/responsive.css), not viewport media queries.
 */
/// <reference lib="dom" />
import type { HostState } from "../store.ts";
import type { RemoteConsolePreset } from "../hosts.ts";
import type { WireActivity } from "../harness/replay-log.ts";
import { IconButton } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Shimmer } from "../ui/Shimmer.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { type RailStatus, statusDotProps } from "./HostRail.tsx";
import { RollingNumber } from "./RollingNumber.tsx";
import { SlidingPill, type PillButtonProps } from "./SlidingPill.tsx";
import { formatCost, hasSessionStats, StatsPopover } from "./StatsPopover.tsx";

const PRESETS: readonly RemoteConsolePreset[] = ["studio", "glass", "paper", "terminal"];

/** Header status text: the run status while connected, else the connection state. */
export function headerStatus(state: HostState | undefined): string {
	if (state === undefined) return "no host selected";
	if (state.connection === "connected" && state.status !== null) {
		const detail = state.status.detail !== undefined ? `: ${state.status.detail}` : "";
		return `${state.status.kind}${detail}`;
	}
	return state.connection;
}

const ACTIVITY_LABEL: Record<WireActivity["kind"], string> = { compaction: "Compacting", memory_fold: "Folding memory" };
const ACTIVITY_FAILED_LABEL: Record<WireActivity["kind"], string> = { compaction: "Compaction failed", memory_fold: "Memory fold failed" };

/** The status word: a running or failed background activity outranks the run status. */
function StatusWord({ activity, working, status }: { activity: WireActivity | null; working: boolean; status: string }) {
	if (activity?.phase === "start") return <Shimmer>{ACTIVITY_LABEL[activity.kind]}</Shimmer>;
	if (activity?.phase === "failed") {
		return (
			<span className="rc-header-status-failed">
				<Icon name="alert" />
				{ACTIVITY_FAILED_LABEL[activity.kind]}
			</span>
		);
	}
	return working ? <Shimmer>{status}</Shimmer> : <>{status}</>;
}

/** Test hook attributes for the preset pill's option buttons. */
function presetProps(preset: RemoteConsolePreset): PillButtonProps {
	return { "data-rc-preset-btn": preset };
}

/** The header has no staleness clock: a closed or missing connection reads as offline. */
function headerDotStatus(state: HostState | undefined): RailStatus {
	return state === undefined || state.connection === "closed" ? "offline" : state.connection;
}

export function Header({
	state,
	preset,
	onPreset,
	onOpenAppearance,
	appearanceOpen = false,
}: {
	state: HostState | undefined;
	preset: RemoteConsolePreset;
	onPreset(preset: RemoteConsolePreset): void;
	onOpenAppearance(): void;
	appearanceOpen?: boolean;
}) {
	const status = headerStatus(state);
	const connection = state?.connection ?? "none";
	const live = state?.connection === "connected";
	const working = live && state?.status?.kind === "working";
	const model = state?.status?.model ?? null;
	const thinking = state?.status?.thinkingLevel;
	const usage = state?.status?.contextUsage ?? null;
	const percent = usage?.percent ?? null;
	const runStatus = state?.status ?? null;
	const stats = state?.status?.stats;
	const liveTps = typeof stats?.tokensPerSecond === "number" ? Math.round(stats.tokensPerSecond) : null;
	const lastTps = state?.lastTokensPerSecond != null ? Math.round(state.lastTokensPerSecond) : null;
	const tokensPerSecond = live ? (liveTps ?? lastTps) : null;
	const tpsStale = liveTps === null;
	const staleMetrics = live ? undefined : "true";
	const autoCompact = state?.status?.autoCompact === true;
	const costUsd = stats?.costUsd;
	const todos = stats !== undefined && stats.todos !== undefined && stats.todos.total > 0 ? stats.todos : null;
	const activity = live ? (state?.activity ?? null) : null;
	const title = state === undefined ? "No host selected" : (state.sessionName ?? state.label);
	return (
		<div className="rc-header-inner" data-rc-header="true">
			<span className="rc-header-title">{title}</span>
			<span className="rc-header-status" data-rc-status={state?.status?.kind ?? "none"}>
				<span className="rc-header-status-dot" data-rc-status-dot={connection} aria-hidden="true">
					<StatusDot {...statusDotProps(headerDotStatus(state), working)} />
				</span>
				<span
					className="rc-header-status-word"
					data-rc-activity={activity?.kind}
					data-rc-activity-phase={activity === null ? undefined : activity.phase}
				>
					<StatusWord activity={activity} working={working} status={status} />
				</span>
			</span>
			<span className="rc-header-spacer" />
			{tokensPerSecond !== null && (
				<span
					className="rc-header-tps"
					data-rc-tps={String(tokensPerSecond)}
					data-rc-tps-stale={tpsStale ? "true" : undefined}
				>
					<span className="rc-sr-only">{`${tpsStale ? "last measured " : ""}${tokensPerSecond} tokens per second`}</span>
					<span className="rc-header-metric-visual" aria-hidden="true">
						<RollingNumber value={tokensPerSecond} /> tok/s
					</span>
				</span>
			)}
			{percent !== null && (
				<span className="rc-header-ctx" data-rc-ctx={String(percent)} data-rc-stale={staleMetrics}>
					<span className="rc-sr-only">{`context usage ${Math.round(percent)} percent${autoCompact ? ", auto-compact on" : ""}`}</span>
					<span className="rc-header-ctx-track" aria-hidden="true">
						<span className="rc-header-ctx-fill" style={{ transform: `scaleX(${Math.min(100, Math.max(0, percent)) / 100})` }} />
					</span>
					<span className="rc-header-ctx-num" aria-hidden="true">
						<RollingNumber value={Math.round(percent)} />%
					</span>
					{autoCompact && (
						<span className="rc-header-auto" data-rc-autocompact="true" aria-hidden="true">
							auto
						</span>
					)}
				</span>
			)}
			{costUsd !== undefined && (
				<span className="rc-header-cost" data-rc-cost={String(costUsd)} data-rc-stale={staleMetrics}>
					<span className="rc-sr-only">{`session cost ${formatCost(costUsd)}`}</span>
					<span className="rc-header-metric-visual" aria-hidden="true">
						{formatCost(costUsd)}
					</span>
				</span>
			)}
			{todos !== null && (
				<span className="rc-header-todos" data-rc-todos={`${todos.done}/${todos.total}`}>
					<span className="rc-sr-only">{`todos ${todos.done} of ${todos.total} done`}</span>
					<span className="rc-header-metric-visual" aria-hidden="true">
						<Icon name="task" />
						{todos.done}/{todos.total}
					</span>
				</span>
			)}
			{model !== null && (
				<span className="rc-header-model" data-rc-model="true">
					{model.provider}/{model.modelId}
				</span>
			)}
			{thinking !== undefined && (
				<span className="rc-header-thinking" data-rc-thinking="true">
					thinking {thinking}
				</span>
			)}
			<span className="rc-header-presets" data-rc-presets="true">
				<SlidingPill
					options={PRESETS.map((candidate) => ({ value: candidate, label: candidate, props: presetProps(candidate) }))}
					active={preset}
					onChange={onPreset}
					ariaLabel="preset"
				/>
			</span>
			{runStatus !== null && hasSessionStats(runStatus) && <StatsPopover status={runStatus} lastTokensPerSecond={state?.lastTokensPerSecond ?? null} appearanceOpen={appearanceOpen} />}
			<IconButton
				icon="sliders"
				label="appearance"
				data-rc-appearance-open="true"
				aria-haspopup="dialog"
				aria-expanded={appearanceOpen}
				onClick={onOpenAppearance}
			/>
		</div>
	);
}
