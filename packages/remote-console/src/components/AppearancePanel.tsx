/**
 * components/AppearancePanel: the appearance overlay. A slide-over (bottom
 * sheet on phones) over a dim scrim: preset swatches, the accent hue
 * slider, the motion auto/off switch, and a live preview strip
 * rendered with the current tokens. Every change calls onChange with a partial
 * Appearance immediately, so App applies it to the document root and persists
 * it in the same tick. Escape, the close button, and the scrim all close;
 * focus is trapped inside while open and restored to the opener on close. The
 * sheet and scrim stay mounted through their exit animation (usePresence).
 * The notify toggle (system notification for a waiting approval) shows only
 * where the Notification API exists in a secure context; turning it on asks
 * for permission and a denial leaves it off with a hint.
 */
/// <reference lib="dom" />
import { useEffect, useRef, useState } from "react";
import { loadNotify, saveNotify } from "../attention.ts";
import type { Appearance, MotionPreference, RemoteConsolePreset } from "../hosts.ts";
import { clampAccentHue } from "../hosts.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { usePresence } from "../ui/usePresence.ts";
import { type PillButtonProps, SlidingPill } from "./SlidingPill.tsx";

const PRESETS: readonly RemoteConsolePreset[] = ["studio", "glass", "paper", "terminal"];
const MOTIONS: readonly MotionPreference[] = ["auto", "off"];
const NOTIFY_OPTIONS = ["on", "off"] as const;
type NotifyChoice = (typeof NOTIFY_OPTIONS)[number];

const notifySupported = (): boolean => window.isSecureContext && "Notification" in window;

/** Test hook attributes for the motion pill's option buttons. */
function motionProps(motion: MotionPreference): PillButtonProps {
	return { "data-rc-appear-motion": motion };
}

/** The first and last tab stops for the focus trap. Decorative controls
 * (tabindex -1) and disabled controls are not stops. */
function focusableIn(panel: HTMLElement): HTMLElement[] {
	const nodes = panel.querySelectorAll<HTMLElement>("button, input");
	return Array.from(nodes).filter((node) => !node.hasAttribute("disabled") && node.getAttribute("tabindex") !== "-1");
}

export function AppearancePanel({
	open,
	appearance,
	onChange,
	onClose,
}: {
	open: boolean;
	appearance: Appearance;
	onChange(patch: Partial<Appearance>): void;
	onClose(): void;
}) {
	const presence = usePresence(open);
	if (!presence.mounted) return null;
	return <AppearanceSheet open={open} appearance={appearance} onChange={onChange} onClose={onClose} />;
}

function AppearanceSheet({
	open,
	appearance,
	onChange,
	onClose,
}: {
	open: boolean;
	appearance: Appearance;
	onChange(patch: Partial<Appearance>): void;
	onClose(): void;
}) {
	const panelRef = useRef<HTMLDivElement | null>(null);
	const [notify, setNotify] = useState<boolean>(
		() => notifySupported() && loadNotify() && Notification.permission === "granted",
	);
	const [blocked, setBlocked] = useState(() => notifySupported() && Notification.permission === "denied");

	const chooseNotify = async (choice: NotifyChoice): Promise<void> => {
		if (choice === "off") {
			setNotify(false);
			saveNotify(false);
			return;
		}
		const permission = await Notification.requestPermission();
		const granted = permission === "granted";
		setBlocked(permission === "denied");
		setNotify(granted);
		saveNotify(granted);
	};

	// Focus lifecycle: take focus on open, hand it back to the opener on close.
	useEffect(() => {
		if (!open) return;
		const opener = document.activeElement as HTMLElement | null;
		panelRef.current?.focus();
		return () => opener?.focus();
	}, [open]);

	// Document-level keys while open: Escape closes, Tab cycles the trap.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== "Tab") return;
			const panel = panelRef.current;
			if (panel === null) return;
			const stops = focusableIn(panel);
			const first = stops[0];
			const last = stops[stops.length - 1];
			if (first === undefined || last === undefined) return;
			const active = document.activeElement;
			if (event.shiftKey && (active === first || active === panel)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (active === last || !panel.contains(active))) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	const state = open ? "open" : "closed";
	return (
		<div className="rc-appear" data-rc-appear-overlay="true" data-state={state}>
			<div
				className="rc-appear-scrim"
				data-rc-appear-scrim="true"
				aria-hidden="true"
				data-state={state}
				onClick={onClose}
			/>
			<div
				className="rc-appear-panel"
				data-rc-appear-panel="true"
				role="dialog"
				aria-modal="true"
				aria-label="appearance"
				data-state={state}
				tabIndex={-1}
				ref={panelRef}
			>
				<div className="rc-appear-head">
					<h2 className="rc-appear-title">Appearance</h2>
					<IconButton icon="x" label="close appearance panel" data-rc-appear-close="true" onClick={onClose} />
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: preview is a styled div; a fieldset adds default border and padding */}
				<div
					className="rc-appear-preview"
					data-rc-appear-preview="true"
					role="group"
					aria-label="appearance preview"
				>
					<div className="rc-appear-preview-msg">hello agent</div>
					<div className="rc-appear-preview-row">
						<span className="rc-appear-pill" data-rc-appear-pill="connected">
							<StatusDot tone="good" />
							connected
						</span>
						<Button variant="primary" size="sm" tabIndex={-1}>
							Send
						</Button>
					</div>
				</div>
				<div className="rc-appear-group" data-rc-appear-presets="true">
					<div className="rc-label" id="rc-appear-preset-label">
						preset
					</div>
					{/* biome-ignore lint/a11y/useSemanticElements: swatch row is a styled flex div; a fieldset would change layout */}
					<div className="rc-appear-swatches" role="group" aria-labelledby="rc-appear-preset-label">
						{PRESETS.map((candidate) => (
							<button
								key={candidate}
								type="button"
								className="rc-appear-swatch"
								data-rc-appear-swatch={candidate}
								data-rc-preset={candidate}
								aria-pressed={candidate === appearance.preset}
								onClick={() => onChange({ preset: candidate })}
							>
								<span className="rc-appear-swatch-chip" aria-hidden="true">
									<span className="rc-appear-swatch-line" />
									<span className="rc-appear-swatch-line" />
									<span className="rc-appear-swatch-dot" />
								</span>
								<span className="rc-appear-swatch-name">
									{candidate}
									{candidate === appearance.preset && <Icon name="check" className="rc-appear-swatch-check" />}
								</span>
							</button>
						))}
					</div>
				</div>
				<div className="rc-appear-group">
					<div className="rc-appear-label-row">
						<label className="rc-label" htmlFor="rc-appear-hue">
							accent hue
						</label>
						<span className="rc-appear-value" data-rc-appear-hue-value={String(appearance.accentHue)}>
							{appearance.accentHue}
						</span>
					</div>
					<input
						id="rc-appear-hue"
						className="rc-appear-slider rc-appear-slider-hue"
						data-rc-appear-hue="true"
						type="range"
						min={0}
						max={360}
						step={1}
						value={appearance.accentHue}
						aria-valuetext={`${appearance.accentHue} degrees`}
						onChange={(event) => {
							// An empty value must not become hue 0 (Number("") is 0): NaN
							// falls through clampAccentHue to the default instead.
							const raw = event.currentTarget.value;
							onChange({ accentHue: clampAccentHue(raw === "" ? Number.NaN : Number(raw)) });
						}}
					/>
				</div>
				<div className="rc-appear-group">
					<div className="rc-label" id="rc-appear-motion-label">
						motion
					</div>
					<div className="rc-appear-motion">
						<SlidingPill
							options={MOTIONS.map((candidate) => ({
								value: candidate,
								label: candidate,
								props: motionProps(candidate),
							}))}
							active={appearance.motion}
							onChange={(motion) => onChange({ motion })}
							ariaLabel="motion"
						/>
					</div>
					<p className="rc-appear-hint">
						auto follows the system reduced-motion setting; off forces every animation to zero.
					</p>
				</div>
				{notifySupported() && (
					<div className="rc-appear-group" data-rc-appear-notify="true">
						<div className="rc-label" id="rc-appear-notify-label">
							Notify me when an approval is waiting
						</div>
						<div className="rc-appear-motion">
							<SlidingPill
								options={NOTIFY_OPTIONS.map((candidate) => ({
									value: candidate,
									label: candidate,
									props: { "data-rc-appear-notify": candidate },
								}))}
								active={notify ? "on" : "off"}
								onChange={(choice) => void chooseNotify(choice)}
								ariaLabel="notify me when an approval is waiting"
							/>
						</div>
						{blocked && (
							<p className="rc-appear-hint" data-rc-appear-notify-blocked="true">
								Blocked in browser settings
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
