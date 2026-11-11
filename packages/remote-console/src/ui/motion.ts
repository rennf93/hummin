/**
 * ui/motion: the two runtime motion switches. motionEnabled mirrors what the
 * CSS tokens do (root data-rc-motion="off" or prefers-reduced-motion zero every
 * duration); withViewTransition wraps a state update in a View Transition when
 * the browser has one and motion is on.
 */
/// <reference lib="dom" />

export function motionEnabled(): boolean {
	if (typeof document === "undefined") return false;
	if (document.documentElement.getAttribute("data-rc-motion") === "off") return false;
	if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
		return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}
	return true;
}

export function withViewTransition(update: () => void): void {
	if (motionEnabled() && typeof document.startViewTransition === "function") {
		document.startViewTransition(update);
		return;
	}
	update();
}
