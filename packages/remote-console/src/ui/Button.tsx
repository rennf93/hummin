/**
 * ui/Button: Button (label, optional leading icon) and IconButton (square,
 * accessible label) on the shared rc-btn styles. Extra props, including data-*
 * and aria-*, land on the root button.
 */
import type { ComponentPropsWithoutRef } from "react";
import { Icon, type IconName } from "./Icon.tsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	className,
	type = "button",
	children,
	...rest
}: ComponentPropsWithoutRef<"button"> & { variant?: Variant; size?: Size; icon?: IconName }) {
	const classes = ["rc-btn", `rc-btn-${variant}`, `rc-btn-${size}`, className].filter(Boolean).join(" ");
	return (
		<button type={type} className={classes} {...rest}>
			{icon === undefined ? null : <Icon name={icon} />}
			{children}
		</button>
	);
}

export function IconButton({
	icon,
	label,
	variant = "ghost",
	size = "md",
	className,
	type = "button",
	...rest
}: ComponentPropsWithoutRef<"button"> & { icon: IconName; label: string; variant?: Variant; size?: Size }) {
	const classes = ["rc-btn", "rc-iconbtn", `rc-btn-${variant}`, `rc-btn-${size}`, className].filter(Boolean).join(" ");
	return (
		<button type={type} className={classes} aria-label={label} title={label} {...rest}>
			<Icon name={icon} />
		</button>
	);
}
