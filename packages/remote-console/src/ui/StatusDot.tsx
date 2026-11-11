/**
 * ui/StatusDot: small tone-coloured dot. activity "pulse" adds one expanding
 * ring (working), "spin" swaps the dot for a rotating arc (reconnecting).
 */
export function StatusDot({
	tone,
	activity = "none",
	className,
}: {
	tone: "idle" | "live" | "good" | "warn" | "bad";
	activity?: "none" | "pulse" | "spin";
	className?: string;
}) {
	return (
		<span
			className={className === undefined ? "rc-dot" : `rc-dot ${className}`}
			data-tone={tone}
			data-activity={activity}
			aria-hidden="true"
		/>
	);
}
