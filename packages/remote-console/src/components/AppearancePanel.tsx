/**
 * components/AppearancePanel: the Phase D appearance overlay. A slide-over
 * (bottom sheet on phones) over a dim scrim: preset swatch cards, the accent
 * hue and density sliders, the motion auto/off switch, and a live preview
 * strip rendered with the current tokens. Every change calls onChange with a
 * partial Appearance immediately, so App applies it to the document root and
 * persists it in the same tick. Escape, the close button, and the scrim all
 * close; focus is trapped inside for the panel's lifetime and restored to the
 * opener on close.
 */
/// <reference lib="dom" />
import { useEffect, useRef, type CSSProperties } from "react";
import type { Appearance, MotionPreference, RemoteConsolePreset } from "../hosts.ts";
import { clampAccentHue, clampDensity } from "../hosts.ts";

const PRESETS: readonly RemoteConsolePreset[] = ["glass", "paper", "terminal"];
const MOTIONS: readonly MotionPreference[] = ["auto", "off"];

/** The first and last tab stops for the focus trap. Decorative controls
 * (tabindex -1) and disabled controls are not stops. */
function focusableIn(panel: HTMLElement): HTMLElement[] {
	const nodes = panel.querySelectorAll<HTMLElement>("button, input");
	return Array.from(nodes).filter((node) => !node.hasAttribute("disabled") && node.getAttribute("tabindex") !== "-1");
}

export function AppearancePanel({
	appearance,
	onChange,
	onClose,
}: {
	appearance: Appearance;
	onChange(patch: Partial<Appearance>): void;
	onClose(): void;
}) {
	const panelRef = useRef<HTMLDivElement | null>(null);

	// Focus lifecycle: take focus on open, hand it back to the opener on close.
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		panelRef.current?.focus();
		return () => opener?.focus();
	}, []);

	// Document-level keys while open: Escape closes, Tab cycles the trap.
	useEffect(() => {
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
			if (stops.length === 0) return;
			const first = stops[0];
			const last = stops[stops.length - 1];
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
	}, [onClose]);

	const densityPercent = `${(((appearance.density - 0.5) / 1.5) * 100).toFixed(1)}%`;
	return (
		<div className="rc-appear" data-rc-appear-overlay="true">
			<div
				className="rc-appear-scrim"
				data-rc-appear-scrim="true"
				aria-hidden="true"
				onClick={onClose}
			/>
			<div
				className="rc-appear-panel"
				data-rc-appear-panel="true"
				role="dialog"
				aria-modal="true"
				aria-label="appearance"
				tabIndex={-1}
				ref={panelRef}
			>
				<div className="rc-appear-head">
					<h2 className="rc-appear-title">Appearance</h2>
					<button
						type="button"
						className="rc-appear-close"
						data-rc-appear-close="true"
						aria-label="close appearance panel"
						onClick={onClose}
					>
						{"\u00D7"}
					</button>
				</div>

				<div className="rc-appear-preview" data-rc-appear-preview="true" role="group" aria-label="appearance preview">
					<article className="rc-appear-preview-msg">
						<span className="rc-appear-preview-role">user</span>
						<span className="rc-appear-preview-text">hello agent</span>
					</article>
					<div className="rc-appear-preview-row">
						<span className="rc-appear-pill" data-rc-appear-pill="connected">
							<span className="rc-appear-pill-dot" aria-hidden="true" />
							connected
						</span>
						<button type="button" className="rc-appear-preview-btn" tabIndex={-1}>
							send
						</button>
					</div>
				</div>

				<div className="rc-appear-group" data-rc-appear-presets="true">
					<div className="rc-appear-label" id="rc-appear-preset-label">preset</div>
					<div className="rc-appear-swatches" role="group" aria-labelledby="rc-appear-preset-label">
						{PRESETS.map((candidate) => (
							<button
								key={candidate}
								type="button"
								className="rc-appear-swatch"
								data-rc-appear-swatch={candidate}
								aria-pressed={candidate === appearance.preset}
								onClick={() => onChange({ preset: candidate })}
							>
								<span className="rc-appear-swatch-chip" aria-hidden="true">
									<span className="rc-appear-swatch-line" />
									<span className="rc-appear-swatch-line" />
									<span className="rc-appear-swatch-dot" />
								</span>
								<span className="rc-appear-swatch-name">{candidate}</span>
							</button>
						))}
					</div>
				</div>

				<div className="rc-appear-group">
					<div className="rc-appear-label-row">
						<label className="rc-appear-label" htmlFor="rc-appear-hue">accent hue</label>
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
						onChange={(event) => onChange({ accentHue: clampAccentHue(Number(event.currentTarget.value)) })}
					/>
				</div>

				<div className="rc-appear-group">
					<div className="rc-appear-label-row">
						<label className="rc-appear-label" htmlFor="rc-appear-density">density</label>
						<span className="rc-appear-value" data-rc-appear-density-value={String(appearance.density)}>
							{appearance.density.toFixed(2)}
						</span>
					</div>
					<input
						id="rc-appear-density"
						className="rc-appear-slider"
						data-rc-appear-density="true"
						type="range"
						min={0.5}
						max={2}
						step={0.05}
						value={appearance.density}
						// The slider's filled-track length is a dynamic custom property; the
						// React style type does not model CSS custom properties.
						style={{ "--rc-slider-fill": densityPercent } as CSSProperties}
						onChange={(event) => onChange({ density: clampDensity(Number(event.currentTarget.value)) })}
					/>
				</div>

				<div className="rc-appear-group">
					<div className="rc-appear-label" id="rc-appear-motion-label">motion</div>
					<div className="rc-appear-motion" role="group" aria-labelledby="rc-appear-motion-label">
						{MOTIONS.map((candidate) => (
							<button
								key={candidate}
								type="button"
								className="rc-appear-motion-btn"
								data-rc-appear-motion={candidate}
								aria-pressed={candidate === appearance.motion}
								onClick={() => onChange({ motion: candidate })}
							>
								{candidate}
							</button>
						))}
					</div>
					<p className="rc-appear-hint">auto follows the system reduced-motion setting; off forces every animation to zero.</p>
				</div>
			</div>
		</div>
	);
}
