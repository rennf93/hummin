/**
 * components/ApprovalCard: the active host's pending tool approval. Shows the
 * tool name, an args preview, and a live countdown to the hold deadline;
 * Approve and Deny resolve the hold through the caller's POST. Hidden when no
 * approval is pending. The countdown is the only local clock: state stays
 * event-driven.
 */
/// <reference lib="dom" />
import { useEffect, useState } from "react";
import type { WireApproval } from "../harness/replay-log.ts";

/** Seconds left before the hold expires and the terminal takes over. */
export function countdownSeconds(approval: WireApproval, now: number): number {
	return Math.max(0, Math.ceil((approval.deadlineMs - now) / 1000));
}

export function ApprovalCard({
	approval,
	onResolve,
}: {
	approval: WireApproval | null;
	onResolve(allow: boolean): void;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (approval === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [approval]);
	if (approval === null) return null;
	return (
		<div className="rc-approval" data-rc-approval="true" data-rc-approval-tool={approval.toolName}>
			<span className="rc-approval-glyph" aria-hidden="true">
				{"\u26A0"}
			</span>
			<span className="rc-approval-body">
				<span className="rc-approval-title">
					<span className="rc-approval-label" data-rc-approval-label="true">approval</span>
					approve <code className="rc-approval-tool">{approval.toolName}</code>
				</span>
				<span className="rc-approval-args">{approval.argsPreview}</span>
			</span>
			<span className="rc-approval-countdown" data-rc-countdown={String(countdownSeconds(approval, now))}>
				{countdownSeconds(approval, now)}s
			</span>
			<button type="button" className="rc-approval-allow" data-rc-approve="true" onClick={() => onResolve(true)}>
				approve
			</button>
			<button type="button" className="rc-approval-deny" data-rc-deny="true" onClick={() => onResolve(false)}>
				deny
			</button>
		</div>
	);
}
