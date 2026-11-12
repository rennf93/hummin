/**
 * ui/Button: Button (label, optional leading icon) and IconButton (square,
 * accessible label) on the shared rc-btn styles. Extra props, including data-*
 * and aria-*, land on the root button. `busy` marks a posting control: the
 * spinner replaces the icon, clicks are swallowed, and the button stays focusable.
 */
import type { ComponentPropsWithoutRef } from "react";
import { Icon, type IconName } from "./Icon.tsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	busy,
	className,
	type = "button",
	children,
	onClick,
	...rest
}: ComponentPropsWithoutRef<"button"> & { variant?: Variant; size?: Size; icon?: IconName; busy?: boolean }) {
	const classes = ["rc-btn", `rc-btn-${variant}`, `rc-btn-${size}`, className].filter(Boolean).join(" ");
	const overlay = busy && icon === undefined;
	return (
		<button
			type={type}
			className={classes}
			aria-busy={busy ? "true" : undefined}
			onClick={busy ? undefined : onClick}
			{...rest}
		>
			{icon === undefined ? null : <Icon name={busy ? "spinner" : icon} />}
			{overlay ? (
				<span className="rc-btn-overlay">
					<Icon name="spinner" />
				</span>
			) : null}
			<span className="rc-btn-label" data-hidden={overlay ? "true" : undefined}>
				{children}
			</span>
		</button>
	);
}

export function IconButton({
	icon,
	label,
	variant = "ghost",
	size = "md",
	busy,
	className,
	type = "button",
	onClick,
	...rest
}: ComponentPropsWithoutRef<"button"> & {
	icon: IconName;
	label: string;
	variant?: Variant;
	size?: Size;
	busy?: boolean;
}) {
	const classes = ["rc-btn", "rc-iconbtn", `rc-btn-${variant}`, `rc-btn-${size}`, className].filter(Boolean).join(" ");
	return (
		<button
			type={type}
			className={classes}
			aria-label={label}
			title={label}
			aria-busy={busy ? "true" : undefined}
			onClick={busy ? undefined : onClick}
			{...rest}
		>
			<Icon name={busy ? "spinner" : icon} />
		</button>
	);
}
