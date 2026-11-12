/**
 * components/HostRail: the fleet column. One row per registered host: a status
 * dot and the session name (the host label when there is none), a second line
 * with the host label and the copyable session id (or, when not connected, the
 * state word in its status tone), and the model id. "connected" is never shown,
 * only read aloud. Clicking a row selects the active host; one absolutely positioned
 * indicator slides under the active row (measured like SlidingPill, re-measured
 * on resize and when rows change size). An unauthorized row carries the
 * token-rotation recovery hint, and a failed console-origin registration shows
 * a non-fatal warning line on that row (in the narrow strip layout those hints
 * leave the chips and render once, full width, below the strip for the active
 * host only). The add-host form lives in a
 * Disclosure opened by the plus button in the rail header (open by default only
 * while no hosts exist, when the onboarding text leads). The remove X opens an inline "Remove <label>?"
 * confirm in the row (Escape or Cancel closes it and refocuses the X); confirming
 * drops the entry (its token stays local to this browser either way). Under the rows, the
 * active host's model-server fleet lists as read-only rows (a live dot on the serving server, first
 * model, host:port and engine, an "in use" label on the serving server); the
 * console never controls servers.
 */
/// <reference lib="dom" />
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { WireFleetServer } from "../harness/replay-log.ts";
import type { HostEntry } from "../hosts.ts";
import { STALE_AFTER_MS } from "../hosts.ts";
import type { HostState } from "../store.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { SessionId } from "../ui/SessionId.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";

export type RailStatus =
	| "connected"
	| "connecting"
	| "reconnecting"
	| "unreachable"
	| "unauthorized"
	| "stale"
	| "offline";

/** Derives the row status state from the host's store slice. */
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

/** StatusDot props for a rail status; the activity pulse is reserved for a
 * connected host whose run is working. */
export function statusDotProps(status: RailStatus, working: boolean): Parameters<typeof StatusDot>[0] {
	switch (status) {
		case "connected":
			return working ? { tone: "live", activity: "pulse" } : { tone: "good" };
		case "connecting":
		case "reconnecting":
			return { tone: "live", activity: "spin" };
		case "stale":
			return { tone: "warn" };
		case "unauthorized":
			return { tone: "bad" };
		case "unreachable":
		case "offline":
			return { tone: "idle" };
	}
}

export interface AddHostInput {
	label: string;
	origin: string;
	token: string;
}

/** Recovery step for a row whose token stopped working: every
 * /remote-control start rotates the token, so the stored one is stale. */
const AUTH_HINT = "token rotated - run /remote-control and reopen its URL, or remove and re-add this host";

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

/** Joins sub-line parts with a "·" whose spacing is margin, so truncation never leaves a stray space before the ellipsis. */
function joinWithSeparator(parts: readonly string[]): ReactNode[] {
	return parts.flatMap((part, index) =>
		index === 0
			? [part]
			: [
					// biome-ignore lint/suspicious/noArrayIndexKey: separators are positional between sub-line parts
					<span key={`sep-${index}`} className="rc-sep" aria-hidden="true">
						·
					</span>,
					part,
				],
	);
}

/** Hint line for a host row: the token-rotation recovery step and a failed origin registration. */
function hostHints(
	status: RailStatus,
	originWarning: string | undefined,
): { auth: boolean; origin: string | undefined } {
	return {
		auth: status === "unauthorized",
		origin:
			originWarning === undefined ? undefined : `origins not registered - cross-origin may fail (${originWarning})`,
	};
}

interface IndicatorGeometry {
	top: number;
	height: number;
}

export function HostRail({
	hosts,
	states,
	activeId,
	originWarnings,
	onSelect,
	onAdd,
	onRemove,
}: {
	hosts: readonly HostEntry[];
	states: Record<string, HostState>;
	activeId: string | null;
	/** Registration failure detail per host id; absence means registered. */
	originWarnings: Record<string, string>;
	onSelect(hostId: string): void;
	onAdd(input: AddHostInput): void;
	onRemove(hostId: string): void;
}) {
	const now = useNowInterval(hosts.length > 0);
	const empty = hosts.length === 0;
	const [formOpen, setFormOpen] = useState(empty);
	const fieldsId = useId();
	// Removing the last host returns to onboarding: the form leads again.
	useEffect(() => {
		if (empty) setFormOpen(true);
	}, [empty]);

	const listRef = useRef<HTMLDivElement>(null);
	const [indicator, setIndicator] = useState<IndicatorGeometry | null>(null);
	const measure = useCallback(() => {
		const active = listRef.current?.querySelector<HTMLElement>('[data-rc-active="true"]') ?? null;
		const next = active === null ? null : { top: active.offsetTop, height: active.offsetHeight };
		setIndicator((current) =>
			current === null || next === null
				? next
				: current.top === next.top && current.height === next.height
					? current
					: next,
		);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId and hosts are re-measure triggers; measure reads the DOM
	useLayoutEffect(measure, [measure, activeId, hosts]);
	// Rows change height when hints or the model line appear; the viewport
	// breakpoint swaps the rail between column and strip.
	useEffect(() => {
		window.addEventListener("resize", measure);
		const list = listRef.current;
		const observer = typeof ResizeObserver === "undefined" || list === null ? null : new ResizeObserver(measure);
		if (observer !== null && list !== null) observer.observe(list);
		return () => {
			window.removeEventListener("resize", measure);
			observer?.disconnect();
		};
	}, [measure]);

	return (
		<div className="rc-rail-inner" data-rc-rail="true">
			<div className="rc-rail-head">
				<span className="rc-label">Hosts</span>
				<IconButton
					icon="plus"
					label="add host"
					size="sm"
					className="rc-rail-add"
					data-rc-add-toggle="true"
					aria-expanded={formOpen}
					aria-controls={formOpen ? fieldsId : undefined}
					onClick={() => setFormOpen((current) => !current)}
				/>
			</div>
			{empty && (
				<div className="rc-onboard" data-rc-empty="true">
					<div className="rc-onboard-title">Add your first host</div>
					<p className="rc-onboard-hint">
						Paste the console origin and bearer token of a running session to bring it into the rail.
					</p>
				</div>
			)}
			<div className="rc-host-list" ref={listRef}>
				<span
					className="rc-rail-indicator"
					data-rc-rail-indicator="true"
					aria-hidden="true"
					style={{
						height: indicator?.height ?? 0,
						opacity: indicator === null ? 0 : 1,
						transform: `translateY(${indicator?.top ?? 0}px)`,
					}}
				/>
				{hosts.map((host) => (
					<HostRow
						key={host.id}
						host={host}
						state={states[host.id]}
						active={host.id === activeId}
						now={now}
						originWarning={originWarnings[host.id]}
						onSelect={onSelect}
						onRemove={onRemove}
					/>
				))}
			</div>
			<StripHints
				status={activeId === null ? undefined : railStatus(states[activeId], now)}
				originWarning={activeId === null ? undefined : originWarnings[activeId]}
			/>
			<FleetSection servers={activeId === null ? undefined : states[activeId]?.fleet} />
			<AddHostForm onAdd={onAdd} open={formOpen} fieldsId={fieldsId} />
		</div>
	);
}

/** Strip layout only (styles/responsive.css shows it, and hides the in-chip hints): the active host's hints on their own full-width line. */
function StripHints({ status, originWarning }: { status: RailStatus | undefined; originWarning: string | undefined }) {
	if (status === undefined) return null;
	const hints = hostHints(status, originWarning);
	if (!hints.auth && hints.origin === undefined) return null;
	return (
		<div className="rc-strip-hints">
			{hints.auth && (
				<span className="rc-host-hint rc-host-hint-bad" data-rc-strip-hint="auth">
					{AUTH_HINT}
				</span>
			)}
			{hints.origin !== undefined && (
				<span className="rc-host-hint" data-rc-strip-hint="origin">
					{hints.origin}
				</span>
			)}
		</div>
	);
}

function FleetSection({ servers }: { servers: readonly WireFleetServer[] | undefined }) {
	if (servers === undefined || servers.length === 0) return null;
	return (
		<div className="rc-fleet" data-rc-fleet="true">
			<span className="rc-label rc-fleet-head">Fleet</span>
			{servers.map((server) => (
				<div className="rc-fleet-row" key={server.id} data-rc-fleet-server={server.id}>
					<span className="rc-fleet-line">
						<StatusDot tone={server.active ? "live" : "idle"} />
						<span className="rc-fleet-name">{server.models[0] ?? server.id}</span>
						{server.active && (
							<span className="rc-fleet-inuse" data-rc-fleet-active="true">
								in use
							</span>
						)}
					</span>
					<span className="rc-fleet-sub">
						{joinWithSeparator([
							`${server.host}:${server.port}`,
							server.engine,
							...(server.discovery === "stale" ? ["stale"] : []),
							...(server.discovery === "none" ? ["not discovered"] : []),
						])}
					</span>
				</div>
			))}
		</div>
	);
}

function HostRow({
	host,
	state,
	active,
	now,
	originWarning,
	onSelect,
	onRemove,
}: {
	host: HostEntry;
	state: HostState | undefined;
	active: boolean;
	now: number;
	originWarning: string | undefined;
	onSelect(hostId: string): void;
	onRemove(hostId: string): void;
}) {
	const status = railStatus(state, now);
	const sessionName = state?.sessionName ?? null;
	const sessionId = state?.sessionId ?? null;
	const model = state?.status?.model ?? null;
	const working = state?.status?.kind === "working";
	const hints = hostHints(status, originWarning);
	const [confirming, setConfirming] = useState(false);
	const rowRef = useRef<HTMLDivElement>(null);
	const focusAfterCancel = useRef(false);
	// Opening the confirm lands focus on the safe choice; closing it returns focus to the X that opened it.
	useEffect(() => {
		if (confirming) rowRef.current?.querySelector<HTMLElement>("[data-rc-remove-cancel]")?.focus();
		else if (focusAfterCancel.current) {
			focusAfterCancel.current = false;
			rowRef.current?.querySelector<HTMLElement>("[data-rc-remove]")?.focus();
		}
	}, [confirming]);
	const cancel = () => {
		focusAfterCancel.current = true;
		setConfirming(false);
	};
	return (
		<div
			className="rc-host-row"
			ref={rowRef}
			data-rc-host-row={host.id}
			data-rc-host-status={status}
			data-rc-active={active ? "true" : undefined}
		>
			{confirming ? (
				// biome-ignore lint/a11y/useSemanticElements: confirm row is a styled flex div; a fieldset would change layout
				<div
					className="rc-host-confirm"
					role="group"
					aria-label={`Remove ${host.label}?`}
					data-rc-remove-confirm={host.id}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.stopPropagation();
						cancel();
					}}
				>
					<span className="rc-host-confirm-text">Remove {host.label}?</span>
					<span className="rc-host-confirm-actions">
						<Button
							variant="danger"
							size="sm"
							data-rc-remove-confirm-yes={host.id}
							onClick={() => onRemove(host.id)}
						>
							Remove
						</Button>
						<Button size="sm" data-rc-remove-cancel={host.id} onClick={cancel}>
							Cancel
						</Button>
					</span>
				</div>
			) : (
				<>
					<div className="rc-host-main">
						<button
							type="button"
							className="rc-host-select"
							title={status}
							aria-current={active ? "true" : undefined}
							onClick={() => onSelect(host.id)}
						>
							<StatusDot {...statusDotProps(status, working)} />
							<span className="rc-host-label">{sessionName ?? host.label}</span>
							{status === "connected" && <span className="rc-sr-only">connected</span>}
						</button>
						<HostSub status={status} hostLabel={sessionName === null ? null : host.label} sessionId={sessionId} />
						{model !== null && (
							<span className="rc-host-model">
								{model.provider}/{model.modelId}
							</span>
						)}
						{hints.auth && (
							<span className="rc-host-hint rc-host-hint-bad" data-rc-auth-hint="true">
								{AUTH_HINT}
							</span>
						)}
						{hints.origin !== undefined && (
							<span className="rc-host-hint" data-rc-origin-warn="true">
								{hints.origin}
							</span>
						)}
					</div>
					<IconButton
						icon="x"
						size="sm"
						className="rc-host-remove"
						data-rc-remove={host.id}
						label={`remove ${host.label}`}
						onClick={() => setConfirming(true)}
					/>
				</>
			)}
		</div>
	);
}

/** Row line 2: the host label and copyable session id while connected, else the state word in its status tone ("connected" stays silent). */
function HostSub({
	status,
	hostLabel,
	sessionId,
}: {
	status: RailStatus;
	hostLabel: string | null;
	sessionId: string | null;
}) {
	if (status !== "connected") {
		return (
			<span className="rc-host-sub rc-host-state" data-rc-host-sub={status}>
				{status}
			</span>
		);
	}
	const id = sessionId === null || sessionId === "" ? null : sessionId;
	if (hostLabel === null && id === null) return null;
	return (
		<span className="rc-host-sub" data-rc-host-sub="connected">
			{hostLabel !== null && <span className="rc-host-sub-label">{hostLabel}</span>}
			{hostLabel !== null && id !== null && (
				<span className="rc-sep" aria-hidden="true">
					·
				</span>
			)}
			{id !== null && <SessionId id={id} />}
		</span>
	);
}

function AddHostForm({ onAdd, open, fieldsId }: { onAdd(input: AddHostInput): void; open: boolean; fieldsId: string }) {
	const [label, setLabel] = useState("");
	const [origin, setOrigin] = useState("");
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const ready = origin.trim() !== "" && token.trim() !== "";
	// Focus the first field when the user opens the form, never on the initial (onboarding) mount.
	const wasOpen = useRef(open);
	const labelRef = useRef<HTMLInputElement | null>(null);
	const focusOnAttach = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			if (labelRef.current === null) focusOnAttach.current = true;
			else labelRef.current.focus();
		}
		wasOpen.current = open;
	}, [open]);
	const attachLabel = useCallback((element: HTMLInputElement | null) => {
		labelRef.current = element;
		if (element !== null && focusOnAttach.current) {
			focusOnAttach.current = false;
			element.focus();
		}
	}, []);
	const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
		set(event.target.value);
		setError(null);
	};
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
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) submit();
			}}
		>
			<Disclosure open={open}>
				<div className="rc-add-fields" id={fieldsId} data-rc-add-open={open ? "true" : "false"}>
					<input
						className="rc-add-input"
						ref={attachLabel}
						data-rc-add-label="true"
						placeholder="label (optional)"
						aria-label="host label"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						value={label}
						onChange={edit(setLabel)}
					/>
					<input
						className="rc-add-input"
						data-rc-add-origin="true"
						type="url"
						inputMode="url"
						placeholder="origin (http://127.0.0.1:PORT)"
						aria-label="host origin"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						value={origin}
						onChange={edit(setOrigin)}
					/>
					<input
						className="rc-add-input"
						data-rc-add-token="true"
						type="password"
						autoComplete="off"
						placeholder="token"
						aria-label="host token"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						value={token}
						onChange={edit(setToken)}
					/>
					{error !== null && (
						<div className="rc-add-error" role="alert">
							{error}
						</div>
					)}
					<Button type="submit" variant="primary" data-rc-add-submit="true" disabled={!ready}>
						add
					</Button>
				</div>
			</Disclosure>
		</form>
	);
}
