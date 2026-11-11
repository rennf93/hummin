/**
 * components/StatsPopover: the "Session" button and its popover. The popover
 * is a portal to document.body with fixed placement under the button, because
 * the header clips its overflow. It lists session facts as a two-column
 * definition list; a row whose value the host did not publish is omitted.
 * Closes on Escape, an outside pointerdown, focus leaving both the popover and
 * its button, the button, and the appearance panel opening; Escape, the button
 * and Tab off the popover's end return focus to the button. Placement is
 * clamped to the viewport (VIEWPORT_MARGIN) and follows resize, scroll and anchor
 * movement. Also exports the pure number formatters the header shares
 * (compact counts, cost).
 */
/// <reference lib="dom" />
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WireStats, WireStatus } from "../harness/replay-log.ts";
import { IconButton } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { usePresence } from "../ui/usePresence.ts";

const COMPACT_UNITS = [[1e9, "B"], [1e6, "M"], [1e3, "k"]] as const;

function scaleCompact(scaled: number): string {
	return (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)).replace(/\.0$/, "");
}

/** 1499 -> "1.5k", 266000 -> "266k", 999950 -> "1M", 40000000 -> "40M"; a dash for NaN, negative or infinite. */
export function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "-";
	const rounded = value < 1000 ? Math.round(value) : value;
	for (const [index, [size, suffix]] of COMPACT_UNITS.entries()) {
		if (rounded < size) continue;
		const text = scaleCompact(rounded / size);
		const larger = COMPACT_UNITS[index - 1];
		// 999.95k prints as "1000k": roll over to the next unit up (B has none above it).
		if (Number(text) >= 1000 && larger !== undefined) return `${scaleCompact(rounded / larger[0])}${larger[1]}`;
		return `${text}${suffix}`;
	}
	return String(rounded);
}

/** Two decimals from one dollar up, three below it so small spends stay visible; "<$0.001" for dust, a dash for junk. */
export function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd < 0) return "-";
	if (usd === 0) return "$0.00";
	if (usd < 0.001) return "<$0.001";
	if (usd < 1) {
		const text = usd.toFixed(3);
		return text === "1.000" ? "$1.00" : `$${text}`;
	}
	return `$${usd.toFixed(2)}`;
}

/** True when the host published any of the hummin-specific fields the popover shows. */
export function hasSessionStats(status: WireStatus): boolean {
	return status.stats !== undefined || status.workspace !== undefined || status.autoCompact !== undefined || status.version !== undefined;
}

interface StatsRow {
	key: string;
	label: string;
	value: ReactNode;
}

/** Token breakdown parts; a field the host did not send is omitted (never "NaN"), cache write only when non-zero. */
function tokenPartsOf(tokens: Partial<NonNullable<WireStats["tokens"]>> | undefined): string[] {
	if (tokens === undefined) return [];
	const parts: string[] = [];
	for (const [label, count, alwaysShown] of [
		["in", tokens.input, true],
		["out", tokens.output, true],
		["cache read", tokens.cacheRead, true],
		["cache write", tokens.cacheWrite, false],
	] as const) {
		if (typeof count !== "number" || !Number.isFinite(count) || (!alwaysShown && count <= 0)) continue;
		parts.push(`${label} ${formatCompactNumber(count)}`);
	}
	return parts;
}

function statsRows(status: WireStatus, lastTokensPerSecond: number | null): StatsRow[] {
	const rows: StatsRow[] = [];
	const { stats, workspace } = status;
	if (workspace !== undefined) {
		rows.push({
			key: "workspace",
			label: "Workspace",
			value: (
				<>
					{(workspace.repo !== undefined || workspace.branch !== undefined) && (
						<span className="rc-stats-line">
							{workspace.repo}
							{workspace.branch !== undefined && (
								<span className="rc-stats-branch">
									<Icon name="branch" />
									{workspace.branch}
								</span>
							)}
						</span>
					)}
					<span className="rc-stats-path" title={workspace.cwd}>
						<bdo dir="ltr">{workspace.cwd}</bdo>
					</span>
				</>
			),
		});
	}
	if (status.model !== null) {
		rows.push({
			key: "model",
			label: "Model",
			value: (
				<>
					<span className="rc-mono">
						{status.model.provider}/{status.model.modelId}
					</span>
					{status.thinkingLevel !== undefined && <span className="rc-stats-dim"> thinking {status.thinkingLevel}</span>}
				</>
			),
		});
	}
	const tokenParts = tokenPartsOf(stats?.tokens);
	if (tokenParts.length > 0) {
		rows.push({ key: "tokens", label: "Tokens", value: <span className="rc-mono">{tokenParts.join(" / ")}</span> });
	}
	if (typeof stats?.cacheHitPercent === "number") {
		rows.push({ key: "cache-hit", label: "Cache hit", value: <span className="rc-mono">{stats.cacheHitPercent.toFixed(1)}%</span> });
	}
	if (stats?.costUsd !== undefined) {
		rows.push({ key: "cost", label: "Cost", value: <span className="rc-mono">{formatCost(stats.costUsd)}</span> });
	}
	if (stats !== undefined && stats.tokensPerSecond !== undefined) {
		const live = stats.tokensPerSecond;
		const speed =
			live !== null ? `${Math.round(live)} tok/s` : lastTokensPerSecond !== null ? `last ${Math.round(lastTokensPerSecond)} tok/s` : "-";
		rows.push({ key: "speed", label: "Speed", value: <span className="rc-mono">{speed}</span> });
	}
	const percent = status.contextUsage?.percent ?? null;
	if (percent !== null) {
		rows.push({
			key: "context",
			label: "Context",
			value: (
				<>
					<span className="rc-mono">{Math.round(percent)}%</span>
					{status.autoCompact !== undefined && <span className="rc-stats-dim"> auto-compact {status.autoCompact ? "on" : "off"}</span>}
				</>
			),
		});
	}
	if (stats?.diff !== undefined) {
		rows.push({
			key: "changes",
			label: "Changes",
			value: (
				<span className="rc-mono">
					<span className="rc-stats-added">+{stats.diff.added}</span> <span className="rc-stats-removed">-{stats.diff.removed}</span>
				</span>
			),
		});
	}
	if (stats?.todos !== undefined && stats.todos.total > 0) {
		rows.push({ key: "todos", label: "Todos", value: <span className="rc-mono">{stats.todos.done}/{stats.todos.total}</span> });
	}
	if (status.version !== undefined) {
		rows.push({ key: "version", label: "Version", value: <span className="rc-mono">{status.version}</span> });
	}
	return rows;
}

interface Placement {
	top: number;
	left: number;
}

const VIEWPORT_MARGIN = 8;
/** Matches the 26rem cap in stats.css at the default root font size; used only until the popover can be measured. */
const FALLBACK_WIDTH = 416;
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right-aligns the popover under its anchor, then clamps it inside the viewport. */
export function clampedPlacement(anchor: { right: number; bottom: number }, popoverWidth: number, viewportWidth: number): Placement {
	const width = popoverWidth > 0 ? popoverWidth : Math.min(FALLBACK_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN);
	const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
	return { top: anchor.bottom + 6, left: Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, anchor.right - width)) };
}

export function StatsPopover({
	status,
	lastTokensPerSecond = null,
	appearanceOpen = false,
}: {
	status: WireStatus;
	lastTokensPerSecond?: number | null;
	appearanceOpen?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const anchorRef = useRef<HTMLSpanElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const { mounted, state } = usePresence(open);

	const focusButton = useCallback(() => anchorRef.current?.querySelector("button")?.focus(), []);
	const place = useCallback(() => {
		const rect = anchorRef.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const next = clampedPlacement(rect, dialogRef.current?.offsetWidth ?? 0, window.innerWidth);
		setPlacement((current) => (current !== null && current.top === next.top && current.left === next.left ? current : next));
	}, []);

	useLayoutEffect(() => {
		if (mounted) place();
	}, [mounted, place]);

	// The appearance sheet is modal: a popover left open under it would be unreachable.
	useEffect(() => {
		if (appearanceOpen) setOpen(false);
	}, [appearanceOpen]);

	useEffect(() => {
		if (!open) return;
		dialogRef.current?.focus();
		const inside = (target: EventTarget | null) =>
			target instanceof Node && (dialogRef.current?.contains(target) === true || anchorRef.current?.contains(target) === true);
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			focusButton();
		};
		// pointerdown, not mousedown: iOS fires no mouse events on non-interactive targets.
		const onPress = (event: Event) => {
			if (!inside(event.target)) setOpen(false);
		};
		const onFocusIn = (event: FocusEvent) => {
			if (!inside(event.target)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPress);
		document.addEventListener("focusin", onFocusIn);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
		const anchor = anchorRef.current;
		if (anchor !== null) observer?.observe(anchor);
		if (anchor?.parentElement) observer?.observe(anchor.parentElement);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPress);
			document.removeEventListener("focusin", onFocusIn);
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
			observer?.disconnect();
		};
	}, [open, place, focusButton]);

	// The dialog is portaled to the end of body, so Tab off its last stop would leave the page; send it back to the button.
	const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab") return;
		const stops = [...(dialogRef.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
		const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
		if (stops.length === 0 || document.activeElement === edge || document.activeElement === dialogRef.current) {
			event.preventDefault();
			focusButton();
		}
	};

	const rows = statsRows(status, lastTokensPerSecond);
	return (
		<>
			<span className="rc-stats-anchor" ref={anchorRef}>
				<IconButton
					icon="chart"
					label="Session"
					data-rc-stats-open={open ? "true" : "false"}
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => {
						if (open) focusButton();
						setOpen((current) => !current);
					}}
				/>
			</span>
			{mounted &&
				createPortal(
					<div
						ref={dialogRef}
						className="rc-stats-pop rc-pop"
						role="dialog"
						aria-label="session stats"
						tabIndex={-1}
						data-rc-stats="true"
						data-state={state}
						onKeyDown={onDialogKeyDown}
						style={placement === null ? { visibility: "hidden" } : { top: placement.top, left: placement.left }}
					>
						<dl className="rc-stats-list">
							{rows.map((row) => (
								<div className="rc-stats-row" key={row.key} data-rc-stats-row={row.key}>
									<dt className="rc-label">{row.label}</dt>
									<dd className="rc-stats-value">{row.value}</dd>
								</div>
							))}
						</dl>
					</div>,
					document.body,
				)}
		</>
	);
}
