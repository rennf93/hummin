/**
 * ui/usePresence: keeps a node mounted through its exit animation. `state`
 * flips to "closed" at once; `mounted` drops after the exit duration. A zero
 * duration (motion off, or a test DOM where the token is unresolved) unmounts
 * in the same render pass with no timer.
 */
/// <reference lib="dom" />
import { useEffect, useMemo, useState } from "react";

function readExitMs(): number {
	if (typeof document === "undefined") return 0;
	const raw = getComputedStyle(document.documentElement).getPropertyValue("--rc-duration-exit").trim();
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value)) return 0;
	return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : 0;
}

export function usePresence(open: boolean, exitMs?: number): { mounted: boolean; state: "open" | "closed" } {
	const [held, setHeld] = useState(open);
	// Read the computed style only when `open` flips, not on every render.
	const exit = useMemo(() => (open ? 0 : (exitMs ?? readExitMs())), [open, exitMs]);
	useEffect(() => {
		if (open) {
			setHeld(true);
			return;
		}
		if (exit <= 0) {
			setHeld(false);
			return;
		}
		const timer = setTimeout(() => setHeld(false), exit);
		return () => clearTimeout(timer);
	}, [open, exit]);
	return { mounted: open || (held && exit > 0), state: open ? "open" : "closed" };
}
