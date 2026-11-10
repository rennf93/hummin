// hummin remote console app shell: three stable regions later phases fill.
/// <reference lib="dom" />
const PRESETS = ["glass", "paper", "terminal"] as const;

export type RemoteConsolePreset = (typeof PRESETS)[number];

/** Reads the active preset from the root element and normalizes unknown or missing values to "glass". */
export function ensurePreset(root: HTMLElement): RemoteConsolePreset {
	const raw = root.dataset.rcPreset;
	const preset = PRESETS.find((candidate) => candidate === raw) ?? "glass";
	if (raw !== preset) {
		root.dataset.rcPreset = preset;
	}
	return preset;
}

/** Renders the console skeleton; regions are addressed by their data-rc-region attribute. */
export function App() {
	const preset = ensurePreset(document.documentElement);
	return (
		<div className="rc-shell" data-rc-preset={preset}>
			<header className="rc-header" data-rc-region="header" />
			<main className="rc-transcript" data-rc-region="transcript" />
			<footer className="rc-composer" data-rc-region="composer" />
		</div>
	);
}
