/**
 * components/SlidingPill: segmented control with a gliding highlight pill,
 * the dashboard's SlidingHighlight ported to TSX. Options render as equal
 * buttons in a borderless track; an absolutely positioned thumb translates under the
 * active option on the spring token. Geometry is measured from the layout
 * (offsetLeft/offsetWidth) so unequal labels land exactly, and re-measured on
 * track reflow. Pure CSS transitions; aria-pressed carries the selection.
 */
/// <reference lib="dom" />
import { type ComponentPropsWithoutRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Button props with the data-* extras call sites hang off for tests. */
export type PillButtonProps = ComponentPropsWithoutRef<"button"> & Record<`data-${string}`, string | undefined>;

export interface PillOption<V extends string = string> {
	value: V;
	label: string;
	props?: PillButtonProps;
}

export function SlidingPill<V extends string>({
	options,
	active,
	onChange,
	ariaLabel,
	className,
	disabled = false,
}: {
	options: readonly PillOption<V>[];
	active: V;
	// NoInfer keeps V out of inference from the callback argument: a state
	// setter (Dispatch<SetStateAction<V>>) as onChange would otherwise drag the
	// candidate union past the `extends string` bound and collapse V to string.
	onChange(value: NoInfer<V>): void;
	ariaLabel: string;
	className?: string;
	disabled?: boolean;
}) {
	const activeIndex = Math.max(
		0,
		options.findIndex((option) => option.value === active),
	);
	const track = useRef<HTMLSpanElement | null>(null);
	const buttons = useRef<Array<HTMLButtonElement | null>>([]);
	const [pill, setPill] = useState({ left: 0, width: 0 });
	const measure = useCallback(() => {
		const button = buttons.current[activeIndex] ?? null;
		if (button === null) return;
		const left = button.offsetLeft;
		const width = button.offsetWidth;
		setPill((current) => (current.left === left && current.width === width ? current : { left, width }));
	}, [activeIndex]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure is passed as the effect itself; its identity changes with the active index
	useLayoutEffect(measure, [measure]);
	// Keep the pill under the active option when the track or any label changes
	// size (preset font swaps, late web fonts); window resize is the fallback.
	// biome-ignore lint/correctness/useExhaustiveDependencies: options.length re-observes the buttons when options are added or removed
	useEffect(() => {
		window.addEventListener("resize", measure);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		if (observer !== null) {
			if (track.current !== null) observer.observe(track.current);
			for (const button of buttons.current) if (button !== null) observer.observe(button);
		}
		let live = true;
		if (typeof document !== "undefined" && document.fonts !== undefined) {
			void document.fonts.ready.then(() => {
				if (live) measure();
			});
		}
		return () => {
			live = false;
			window.removeEventListener("resize", measure);
			observer?.disconnect();
		};
	}, [measure, options.length]);
	return (
		// biome-ignore lint/a11y/useSemanticElements: pill track is a styled inline span; fieldset is block-level with default border/padding
		<span
			ref={track}
			className={className === undefined ? "rc-pill" : `rc-pill ${className}`}
			role="group"
			aria-label={ariaLabel}
		>
			<span
				className="rc-pill-thumb"
				aria-hidden="true"
				style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
			/>
			{options.map((option, index) => (
				<button
					key={option.value}
					type="button"
					ref={(node) => {
						buttons.current[index] = node;
					}}
					className="rc-pill-btn"
					aria-pressed={option.value === active}
					disabled={disabled}
					onClick={() => onChange(option.value)}
					{...option.props}
				>
					{option.label}
				</button>
			))}
		</span>
	);
}
