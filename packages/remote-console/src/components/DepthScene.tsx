/**
 * components/DepthScene: layer 0 of the glass system, fixed behind the app -
 * three accent-tinted orbs on a slow transform drift plus the film-grain tile.
 * Colors, grain opacity and visibility (--rc-scene-display) are preset tokens,
 * so the appearance panel re-themes the whole scene (studio: not rendered,
 * glass: visible mesh, paper: faint wash, terminal: whisper).
 */
/// <reference lib="dom" />
export function DepthScene() {
	return (
		<div className="rc-scene" data-rc-scene="true" aria-hidden="true">
			<span className="rc-orb rc-orb-a" />
			<span className="rc-orb rc-orb-b" />
			<span className="rc-orb rc-orb-c" />
			<span className="rc-grain" />
		</div>
	);
}
