/**
 * components/Header: the active host's status island. Run status (idle,
 * working, waiting with its terminal detail), model and thinking level,
 * context usage percent on a rolling-digit readout with a glowing meter, the
 * preset quick-switch as a sliding-pill segmented control that drives the
 * appearance store, and the button that opens the full appearance panel.
 */
/// <reference lib="dom" />
import type { HostState } from "../store.ts";
import type { RemoteConsolePreset } from "../hosts.ts";
import { RollingNumber } from "./RollingNumber.tsx";
import { SlidingPill, type PillButtonProps } from "./SlidingPill.tsx";

const PRESETS: readonly RemoteConsolePreset[] = ["glass", "paper", "terminal"];

/** Header status text: the run status when known, else the connection state. */
export function headerStatus(state: HostState | undefined): string {
	if (state === undefined) return "no host selected";
	if (state.status !== null) {
		const detail = state.status.detail !== undefined ? `: ${state.status.detail}` : "";
		return `${state.status.kind}${detail}`;
	}
	return state.connection;
}

/** Test hook attributes for the preset pill's option buttons. */
function presetProps(preset: RemoteConsolePreset): PillButtonProps {
	return { "data-rc-preset-btn": preset };
}

export function Header({
	state,
	preset,
	onPreset,
	onOpenAppearance,
}: {
	state: HostState | undefined;
	preset: RemoteConsolePreset;
	onPreset(preset: RemoteConsolePreset): void;
	onOpenAppearance(): void;
}) {
	const status = headerStatus(state);
	const connection = state?.connection ?? "none";
	const model = state?.status?.model ?? null;
	const thinking = state?.status?.thinkingLevel;
	const usage = state?.status?.contextUsage ?? null;
	const percent = usage?.percent ?? null;
	return (
		<div className="rc-header-inner" data-rc-header="true">
			<span className="rc-header-status" data-rc-status={state?.status?.kind ?? "none"}>
				<span className="rc-header-status-dot" data-rc-status-dot={connection} aria-hidden="true" />
				{status}
			</span>
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
			{percent !== null && (
				<span className="rc-header-ctx" data-rc-ctx={String(percent)} aria-label={`context usage ${Math.round(percent)} percent`}>
					<span className="rc-header-ctx-label">ctx</span>
					<span className="rc-header-ctx-track" aria-hidden="true">
						<span className="rc-header-ctx-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
					</span>
					<span className="rc-header-ctx-num">
						<RollingNumber value={Math.round(percent)} />
						%
					</span>
				</span>
			)}
			<span className="rc-header-spacer" />
			<span className="rc-header-presets" data-rc-presets="true">
				<SlidingPill
					options={PRESETS.map((candidate) => ({ value: candidate, label: candidate, props: presetProps(candidate) }))}
					active={preset}
					onChange={onPreset}
					ariaLabel="preset"
				/>
			</span>
			<button
				type="button"
				className="rc-appear-open"
				data-rc-appearance-open="true"
				aria-haspopup="dialog"
				onClick={onOpenAppearance}
			>
				appearance
			</button>
		</div>
	);
}
