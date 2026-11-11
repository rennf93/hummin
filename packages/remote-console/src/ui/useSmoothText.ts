/**
 * ui/useSmoothText: paces streamed text so tokens land as a steady flow. A
 * requestAnimationFrame loop reveals toward the target at max(60 chars/s,
 * backlog / 0.35s). Returns the target untouched (no state lag) when not
 * streaming, when motion is off, or without rAF; snaps when the target shrinks
 * or is replaced; never ends on half of a surrogate pair.
 */
/// <reference lib="dom" />
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motionEnabled } from "./motion.ts";

const MIN_CHARS_PER_SECOND = 60;
const CATCH_UP_SECONDS = 0.35;

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

export function useSmoothText(target: string, streaming: boolean): string {
	const animate = streaming && typeof requestAnimationFrame === "function" && motionEnabled();
	const [count, setCount] = useState(animate ? 0 : target.length);
	const position = useRef(count);
	const previous = useRef(target);
	const targetRef = useRef(target);
	const lastFrame = useRef<number | null>(null);

	useLayoutEffect(() => {
		const replaced = !target.startsWith(previous.current);
		previous.current = target;
		targetRef.current = target;
		if (replaced || !animate) {
			position.current = target.length;
			setCount(target.length);
		}
	}, [target, animate]);

	useEffect(() => {
		if (!animate) return;
		let frame = 0;
		lastFrame.current = null;
		const step = (now: number) => {
			const target = targetRef.current;
			const dt = lastFrame.current === null ? 0 : (now - lastFrame.current) / 1000;
			lastFrame.current = now;
			const backlog = target.length - position.current;
			if (backlog > 0) {
				position.current = Math.min(
					target.length,
					position.current + Math.max(MIN_CHARS_PER_SECOND, backlog / CATCH_UP_SECONDS) * dt,
				);
				let next = Math.floor(position.current);
				if (next < target.length && next > 0 && isHighSurrogate(target.charCodeAt(next - 1))) next += 1;
				setCount((current) => (current === next ? current : next));
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [animate]);

	if (!animate) return target;
	let end = Math.min(count, target.length);
	if (end > 0 && end < target.length && isHighSurrogate(target.charCodeAt(end - 1))) end -= 1;
	return target.slice(0, end);
}
