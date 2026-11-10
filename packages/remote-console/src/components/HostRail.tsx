/**
 * components/HostRail: the fleet column. One row per registered host with its
 * live status glyph (connected, stale after 30 quiet seconds, reconnecting,
 * unreachable, unauthorized), label, session name, and model; clicking a row
 * selects the active host. With no hosts the rail shows the onboarding card
 * with the add form inline. The add-host form appends to the browser registry
 * (expanded by the toggle on phones, always visible on desktop); remove drops
 * the entry (its token stays local to this browser either way).
 */
/// <reference lib="dom" />
import { useEffect, useState } from "react";
import type { HostEntry } from "../hosts.ts";
import { STALE_AFTER_MS } from "../hosts.ts";
import type { HostState } from "../store.ts";

export type RailStatus = "connected" | "connecting" | "reconnecting" | "unreachable" | "unauthorized" | "stale" | "offline";

/** Derives the row status glyph state from the host's store slice. */
export function railStatus(state: HostState | undefined, now: number): RailStatus {
	if (state === undefined) return "offline";
	switch (state.connection) {
		case "connected":
			return state.lastSeenMs !== null && now - state.lastSeenMs > STALE_AFTER_MS ? "stale" : "connected";
		case "connecting":
			return "connecting";
		case "reconnecting":
			return "reconnecting";
		case "unreachable":
			return "unreachable";
		case "unauthorized":
			return "unauthorized";
		case "closed":
			return "offline";
	}
}

const STATUS_GLYPH: Record<RailStatus, string> = {
	connected: "\u25CF",
	connecting: "\u25D0",
	reconnecting: "\u25D1",
	unreachable: "\u25CB",
	unauthorized: "\u25B2",
	stale: "\u25CC",
	offline: "\u25CB",
};

export interface AddHostInput {
	label: string;
	origin: string;
	token: string;
}

/** Re-renders on a 2s tick so staleness becomes visible without traffic. */
function useNowInterval(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		const timer = setInterval(() => setNow(Date.now()), 2000);
		return () => clearInterval(timer);
	}, [enabled]);
	return now;
}

export function HostRail({
	hosts,
	states,
	activeId,
	onSelect,
	onAdd,
	onRemove,
}: {
	hosts: readonly HostEntry[];
	states: Record<string, HostState>;
	activeId: string | null;
	onSelect(hostId: string): void;
	onAdd(input: AddHostInput): void;
	onRemove(hostId: string): void;
}) {
	const now = useNowInterval(hosts.length > 0);
	const empty = hosts.length === 0;
	const [formOpen, setFormOpen] = useState(empty);
	// Removing the last host returns to onboarding: the form leads again.
	useEffect(() => {
		if (empty) setFormOpen(true);
	}, [empty]);
	return (
		<div className="rc-rail-inner" data-rc-rail="true">
			<div className="rc-rail-title">hosts</div>
			{empty && (
				<div className="rc-onboard" data-rc-empty="true">
					<div className="rc-onboard-title">Add your first host</div>
					<p className="rc-onboard-hint">Paste the console origin and bearer token of a running session to bring it into the rail.</p>
				</div>
			)}
			{hosts.map((host) => (
				<HostRow key={host.id} host={host} state={states[host.id]} active={host.id === activeId} now={now} onSelect={onSelect} onRemove={onRemove} />
			))}
			<AddHostForm onAdd={onAdd} open={formOpen} onToggle={() => setFormOpen((current) => !current)} />
		</div>
	);
}

function HostRow({
	host,
	state,
	active,
	now,
	onSelect,
	onRemove,
}: {
	host: HostEntry;
	state: HostState | undefined;
	active: boolean;
	now: number;
	onSelect(hostId: string): void;
	onRemove(hostId: string): void;
}) {
	const status = railStatus(state, now);
	const session = state?.sessionName ?? null;
	const model = state?.status?.model ?? null;
	return (
		<div className={`rc-host-row${active ? " rc-host-row-active" : ""}`} data-rc-host-row={host.id} data-rc-host-status={status} data-rc-active={active ? "true" : undefined}>
			<button type="button" className="rc-host-select" onClick={() => onSelect(host.id)}>
				<span className="rc-host-glyph" aria-hidden="true">
					{STATUS_GLYPH[status]}
				</span>
				<span className="rc-host-text">
					<span className="rc-host-label">{host.label}</span>
					<span className="rc-host-sub" data-rc-host-sub={status}>
						{status}
						{session !== null && ` \u00B7 ${session}`}
					</span>
					{model !== null && <span className="rc-host-model">{model.provider}/{model.modelId}</span>}
				</span>
			</button>
			<button type="button" className="rc-host-remove" data-rc-remove={host.id} aria-label={`remove ${host.label}`} onClick={() => onRemove(host.id)}>
				{"\u00D7"}
			</button>
		</div>
	);
}

function AddHostForm({
	onAdd,
	open,
	onToggle,
}: {
	onAdd(input: AddHostInput): void;
	open: boolean;
	onToggle(): void;
}) {
	const [label, setLabel] = useState("");
	const [origin, setOrigin] = useState("");
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const ready = origin.trim() !== "" && token.trim() !== "";
	const submit = () => {
		setError(null);
		try {
			onAdd({ label, origin, token });
			setLabel("");
			setOrigin("");
			setToken("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	return (
		<form
			className="rc-add-host"
			data-rc-add-form="true"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) submit();
			}}
		>
			<div className="rc-add-head">
				<div className="rc-rail-title">add host</div>
				<button
					type="button"
					className="rc-add-toggle"
					data-rc-add-toggle="true"
					aria-expanded={open}
					aria-controls="rc-add-fields"
					onClick={onToggle}
				>
					{open ? "close" : "add"}
				</button>
			</div>
			<div className="rc-add-fields" id="rc-add-fields" data-rc-add-open={open ? "true" : "false"}>
				<input
					className="rc-add-input"
					data-rc-add-label="true"
					placeholder="label (optional)"
					aria-label="host label"
					value={label}
					onChange={(event) => setLabel(event.target.value)}
				/>
				<input
					className="rc-add-input"
					data-rc-add-origin="true"
					placeholder="origin (http://127.0.0.1:PORT)"
					aria-label="host origin"
					value={origin}
					onChange={(event) => setOrigin(event.target.value)}
				/>
				<input
					className="rc-add-input"
					data-rc-add-token="true"
					placeholder="token"
					aria-label="host token"
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
				{error !== null && <div className="rc-add-error">{error}</div>}
				<button type="submit" className="rc-add-submit" data-rc-add-submit="true" disabled={!ready}>
					add
				</button>
			</div>
		</form>
	);
}
