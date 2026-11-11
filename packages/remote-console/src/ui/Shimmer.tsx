/**
 * ui/Shimmer: text with a highlight sweeping across it (the "working" label).
 * Inactive, it is plain text in the inherited colour.
 */
import type { ReactNode } from "react";

export function Shimmer({ children, active = true, className }: { children: ReactNode; active?: boolean; className?: string }) {
	return (
		<span className={className === undefined ? "rc-shimmer" : `rc-shimmer ${className}`} data-active={active}>
			{children}
		</span>
	);
}
