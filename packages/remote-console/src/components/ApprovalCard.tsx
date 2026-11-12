/**
 * components/ApprovalCard: the active host's pending tool approvals, one card
 * per hold (concurrent holds each get their own countdown and buttons). Shows
 * the tool name, an args preview, a live countdown, and the honest expiry
 * terms: when the deadline passes, the call proceeds - approvals are a
 * convenience surface, not a security boundary. Approve and Deny resolve the
 * hold through the caller's POST. Hidden when no hold is pending. The
 * countdown is the only local clock: state stays event-driven. A thin warn bar
 * depletes across the card's top over the hold's remaining lifetime, measured
 * once on mount and handed to a CSS animation (no per-frame JS). Deadlines
 * are host-clock: the caller passes the host's clock offset so a skewed
 * browser clock does not shorten or stretch the countdown. Resolving is
 * pending (buttons disabled) until the hold leaves; a failed POST shows an
 * inline error because the hold may still expire. The list is a polite-free
 * assertive live region so a new hold is announced without taking focus. A
 * resolved or expired hold stays mounted through its exit animation
 * (usePresence), kept in a local list of last-known holds.
 */
/// <reference lib="dom" />
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { type ActionResult, describeSendFailure } from "../connection.ts";
import type { WireApproval } from "../harness/replay-log.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { usePresence } from "../ui/usePresence.ts";

/** Seconds left before the hold expires and the call proceeds (fail-open). */
export function countdownSeconds(approval: WireApproval, now: number): number {
	return Math.max(0, Math.ceil((approval.deadlineMs - now) / 1000));
}

/** Args shown before the "Show all" disclosure appears. */
const ARGS_PREVIEW_LINES = 2;
const ARGS_PREVIEW_CHARS = 160;

function HoldCard({
	hold,
	now,
	clockOffsetMs,
	open,
	onResolve,
	onExited,
}: {
	hold: WireApproval;
	now: number;
	clockOffsetMs: number;
	/** False once the hold left the store: the card plays its exit, then onExited. */
	open: boolean;
	onResolve(id: string, allow: boolean): Promise<ActionResult>;
	onExited(id: string): void;
}) {
	const presence = usePresence(open);
	useEffect(() => {
		if (!presence.mounted) onExited(hold.id);
	}, [presence.mounted, hold.id, onExited]);
	// Measured once: the bar animation must not restart on every countdown tick.
	const [lifetimeMs] = useState(() => Math.max(0, hold.deadlineMs - (Date.now() - clockOffsetMs)));
	// Which button is in flight: it shows the spinner; both stay disabled.
	const [pending, setPending] = useState<"allow" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	// shortcut: wrapped length is not measurable without layout, so a long single line is guessed by characters.
	const long =
		hold.argsPreview.split("\n").length > ARGS_PREVIEW_LINES || hold.argsPreview.length > ARGS_PREVIEW_CHARS;
	const seconds = countdownSeconds(hold, now - clockOffsetMs);
	const resolve = async (allow: boolean): Promise<void> => {
		if (pending !== null) return;
		setPending(allow ? "allow" : "deny");
		setError(null);
		const result = await onResolve(hold.id, allow);
		// On success the hold leaves with its approval_done; stay pending until then.
		if (result.ok) return;
		setPending(null);
		setError(`${describeSendFailure(result)}. The hold may still expire and the call proceed.`);
	};
	if (!presence.mounted) return null;
	return (
		// biome-ignore lint/a11y/useSemanticElements: card is a styled div; a fieldset would change layout and animation box
		<div
			className="rc-approval"
			data-state={presence.state}
			role="group"
			aria-label={`approval needed: ${hold.toolName}`}
			data-rc-approval={hold.id}
			data-rc-approval-tool={hold.toolName}
		>
			<span className="rc-approval-bar" aria-hidden="true" style={{ animationDuration: `${lifetimeMs}ms` }} />
			<Icon name="alert" className="rc-approval-glyph" />
			<span className="rc-approval-body">
				<span className="rc-approval-title">
					<span className="rc-approval-label" data-rc-approval-label="true">
						approval
					</span>
					<code className="rc-approval-tool">{hold.toolName}</code> wants to run
				</span>
				<span className="rc-approval-args" data-rc-approval-args={expanded || !long ? "expanded" : "clamped"}>
					{hold.argsPreview}
				</span>
				{long && (
					<button
						type="button"
						className="rc-approval-more"
						data-rc-approval-more="true"
						aria-expanded={expanded}
						onClick={() => setExpanded((current) => !current)}
					>
						{expanded ? "Show less" : "Show all"}
					</button>
				)}
				<span className="rc-approval-hint">
					expiry proceeds with the call: approvals are a convenience surface, not a security boundary
				</span>
				{error !== null && (
					<span className="rc-approval-error" role="alert" data-rc-approval-error="true">
						{error}
					</span>
				)}
			</span>
			<span className="rc-approval-countdown" data-rc-countdown={String(seconds)}>
				{seconds}s
			</span>
			<span className="rc-approval-actions">
				<Button
					variant="ghost"
					data-rc-deny={hold.id}
					busy={pending === "deny"}
					disabled={pending !== null}
					onClick={() => void resolve(false)}
				>
					Deny
				</Button>
				<Button
					variant="primary"
					data-rc-approve={hold.id}
					busy={pending === "allow"}
					disabled={pending !== null}
					onClick={() => void resolve(true)}
				>
					Approve
				</Button>
			</span>
		</div>
	);
}

export function ApprovalCard({
	holds,
	clockOffsetMs = 0,
	onResolve,
}: {
	holds: readonly WireApproval[];
	/** Browser receive time minus host event time; 0 when unknown. */
	clockOffsetMs?: number;
	onResolve(id: string, allow: boolean): Promise<ActionResult>;
}) {
	const [now, setNow] = useState(() => Date.now());
	// Refresh at once when a hold arrives: `now` is stale while no interval ran.
	useLayoutEffect(() => {
		if (holds.length > 0) setNow(Date.now());
	}, [holds.length]);
	useEffect(() => {
		if (holds.length === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [holds]);
	// Last-known holds: a hold that left stays here until its card finishes the exit.
	const [known, setKnown] = useState<readonly WireApproval[]>(holds);
	const [lastHolds, setLastHolds] = useState(holds);
	if (lastHolds !== holds) {
		setLastHolds(holds);
		setKnown([...holds, ...known.filter((old) => !holds.some((hold) => hold.id === old.id))]);
	}
	const onExited = useCallback((id: string) => {
		setKnown((current) =>
			current.some((hold) => hold.id === id) ? current.filter((hold) => hold.id !== id) : current,
		);
	}, []);
	// The live region stays mounted so a hold added to it is announced.
	return (
		<div className="rc-approval-list" aria-live="assertive">
			{known.map((hold) => (
				<HoldCard
					key={hold.id}
					hold={hold}
					now={now}
					clockOffsetMs={clockOffsetMs}
					open={holds.some((live) => live.id === hold.id)}
					onResolve={onResolve}
					onExited={onExited}
				/>
			))}
		</div>
	);
}
