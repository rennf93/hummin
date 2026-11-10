/**
 * components/ApprovalCard: the active host's pending tool approvals, one card
 * per hold (concurrent holds each get their own countdown and buttons). Shows
 * the tool name, an args preview, a live countdown, and the honest expiry
 * terms: when the deadline passes, the call proceeds - approvals are a
 * convenience surface, not a security boundary. Approve and Deny resolve the
 * hold through the caller's POST. Hidden when no hold is pending. The
 * countdown is the only local clock: state stays event-driven.
 */
/// <reference lib="dom" />
import { useEffect, useState } from "react";
import type { WireApproval } from "../harness/replay-log.ts";

/** Seconds left before the hold expires and the call proceeds (fail-open). */
export function countdownSeconds(approval: WireApproval, now: number): number {
	return Math.max(0, Math.ceil((approval.deadlineMs - now) / 1000));
}

export function ApprovalCard({
	holds,
	onResolve,
}: {
	holds: readonly WireApproval[];
	onResolve(id: string, allow: boolean): void;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (holds.length === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [holds]);
	if (holds.length === 0) return null;
	return (
		<>
			{holds.map((hold) => (
				<div key={hold.id} className="rc-approval" data-rc-approval={hold.id} data-rc-approval-tool={hold.toolName}>
					<span className="rc-approval-glyph" aria-hidden="true">
						{"\u26A0"}
					</span>
					<span className="rc-approval-body">
						<span className="rc-approval-title">
							<span className="rc-approval-label" data-rc-approval-label="true">approval</span>
							approve <code className="rc-approval-tool">{hold.toolName}</code>
						</span>
						<span className="rc-approval-args">{hold.argsPreview}</span>
						<span className="rc-approval-hint">expiry proceeds with the call: approvals are a convenience surface, not a security boundary</span>
					</span>
					<span className="rc-approval-countdown" data-rc-countdown={String(countdownSeconds(hold, now))}>
						{countdownSeconds(hold, now)}s
					</span>
					<button type="button" className="rc-approval-allow" data-rc-approve={hold.id} onClick={() => onResolve(hold.id, true)}>
						approve
					</button>
					<button type="button" className="rc-approval-deny" data-rc-deny={hold.id} onClick={() => onResolve(hold.id, false)}>
						deny
					</button>
				</div>
			))}
		</>
	);
}
