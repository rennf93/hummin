/**
 * ui/Disclosure: animated expand/collapse. Height runs 0fr to 1fr through
 * grid-template-rows keyframes; children unmount after the exit (usePresence),
 * so a closed disclosure costs no DOM.
 */
import type { ReactNode } from "react";
import { usePresence } from "./usePresence.ts";

export function Disclosure({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
	const { mounted } = usePresence(open);
	if (!mounted) return null;
	return (
		<div className={className === undefined ? "rc-disclosure" : `rc-disclosure ${className}`} data-open={open}>
			<div className="rc-disclosure-inner">{children}</div>
		</div>
	);
}
