/**
 * ui/Icon: inline SVG glyphs on a 16 box, 1.5 stroke, currentColor, sized by
 * --rc-icon. Decorative (aria-hidden); wrap in IconButton for an accessible name.
 */
import type { ReactNode } from "react";

export type IconName =
	| "chevron-right"
	| "chevron-down"
	| "check"
	| "x"
	| "alert"
	| "arrow-up"
	| "arrow-down"
	| "stop"
	| "plus"
	| "sliders"
	| "terminal"
	| "file"
	| "pencil"
	| "search"
	| "sparkle"
	| "clock"
	| "spinner"
	| "trash"
	| "queue"
	| "task"
	| "question"
	| "tool"
	| "copy"
	| "branch"
	| "chart"
	| "circle";

const GLYPHS: Record<IconName, ReactNode> = {
	"chevron-right": <path d="M6 3.5 10.5 8 6 12.5" />,
	"chevron-down": <path d="M3.5 6 8 10.5 12.5 6" />,
	check: <path d="M3 8.5 6.5 12 13 4.5" />,
	x: <path d="M4 4 12 12M12 4 4 12" />,
	alert: <path d="M8 2 14.5 13.5H1.5ZM8 6.5v3M8 11.5h.01" />,
	"arrow-up": <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />,
	"arrow-down": <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />,
	stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
	plus: <path d="M8 3v10M3 8h10" />,
	sliders: (
		<>
			<path d="M2 4.5h6.5M11.5 4.5H14M2 11.5h2.5M7.5 11.5H14" />
			<circle cx="10" cy="4.5" r="1.5" />
			<circle cx="6" cy="11.5" r="1.5" />
		</>
	),
	terminal: <path d="M3 4.5 6.5 8 3 11.5M8 12h5" />,
	file: <path d="M4.5 1.5H9.5L13 5v8.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM9.5 1.5V5H13" />,
	pencil: <path d="m10.5 2.5 3 3L5 14H2v-3ZM9 4l3 3" />,
	search: (
		<>
			<circle cx="7" cy="7" r="4.5" />
			<path d="M10.5 10.5 14 14" />
		</>
	),
	sparkle: <path d="M8 2c.5 3.2 2.8 5.5 6 6-3.2.5-5.5 2.8-6 6-.5-3.2-2.8-5.5-6-6 3.2-.5 5.5-2.8 6-6Z" />,
	clock: (
		<>
			<circle cx="8" cy="8" r="6" />
			<path d="M8 4.5V8l2.2 1.5" />
		</>
	),
	spinner: <path d="M8 2A6 6 0 1 0 14 8" />,
	trash: <path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.7 9h6.6l.7-9M6.5 7v4M9.5 7v4" />,
	queue: <path d="M2.5 4h11M2.5 8h11M2.5 12h6" />,
	task: (
		<>
			<rect x="2.5" y="2.5" width="11" height="11" rx="2" />
			<path d="m5.5 8 2 2 3-3.5" />
		</>
	),
	question: (
		<>
			<circle cx="8" cy="8" r="6" />
			<path d="M6.2 6.3a1.9 1.9 0 1 1 2.8 1.7c-.7.4-1 .8-1 1.5M8 11.5h.01" />
		</>
	),
	tool: (
		<path d="M10 2.5a3.5 3.5 0 0 0-3.3 4.7L2.5 11.4a1.4 1.4 0 0 0 2 2l4.2-4.2A3.5 3.5 0 0 0 13.5 6l-2 2-2-.5-.5-2 2-2A3.5 3.5 0 0 0 10 2.5Z" />
	),
	branch: (
		<>
			<circle cx="4.5" cy="3.5" r="1.5" />
			<circle cx="4.5" cy="12.5" r="1.5" />
			<circle cx="11.5" cy="5.5" r="1.5" />
			<path d="M4.5 5v6M11.5 7c0 2.5-2 3-7 3.5" />
		</>
	),
	chart: <path d="M2.5 13.5h11M4.5 11V8M8 11V3.5M11.5 11V6" />,
	circle: <circle cx="8" cy="8" r="5.5" />,
	copy: (
		<>
			<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
			<path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
		</>
	),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
	const classes = ["rc-icon", name === "spinner" ? "rc-icon-spinner" : undefined, className].filter(Boolean).join(" ");
	return (
		<svg
			className={classes}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{GLYPHS[name]}
		</svg>
	);
}
