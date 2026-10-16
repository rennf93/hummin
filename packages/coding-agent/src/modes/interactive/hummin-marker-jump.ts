import type { ScrollView } from "@earendil-works/pi-tui";
import { theme } from "./theme/theme.ts";

/** A scrollbar marker dot painted on the transcript viewport. */
export interface TranscriptMarker {
	trackRow: number;
	contentRow: number;
	kind: string;
}

export type MarkerJumpDirection = "previous" | "next";

/** Scrollbar marker colors by marker kind (evaluated lazily so theme switches apply). */
export const SCROLLBAR_MARKER_STYLES: Record<string, (text: string) => string> = {
	user: (text) => theme.fg("accent", text),
	system: (text) => theme.fg("muted", text),
	turnEnd: (text) => theme.fg("dim", text),
};

/**
 * Find the marker to scroll to when jumping to the previous/next marker.
 * "previous" = largest contentRow strictly below scrollTop + 1; "next" = smallest contentRow strictly above scrollTop. Returns undefined when no target exists.
 */
export function findMarkerJumpTarget(
	markers: ReadonlyArray<TranscriptMarker>,
	scrollTop: number,
	direction: MarkerJumpDirection,
): TranscriptMarker | undefined {
	let best: TranscriptMarker | undefined;
	for (const marker of markers) {
		const candidate = direction === "previous" ? marker.contentRow < scrollTop + 1 : marker.contentRow > scrollTop;
		if (!candidate) continue;
		if (
			best === undefined ||
			(direction === "previous" ? marker.contentRow > best.contentRow : marker.contentRow < best.contentRow)
		) {
			best = marker;
		}
	}
	return best;
}

export function jumpToMarker(transcript: ScrollView | undefined, direction: MarkerJumpDirection): void {
	if (!transcript) {
		return;
	}
	const target = findMarkerJumpTarget(transcript.scrollbarPaintedMarkers, transcript.scrollTop, direction);
	if (target === undefined) {
		return;
	}
	// Turn-end markers align to the viewport bottom so the end of the turn is visible; user/system markers align their message to the top.
	const top =
		target.kind === "turnEnd" ? Math.max(0, target.contentRow - transcript.viewportHeight + 1) : target.contentRow;
	transcript.scrollTo(top, { disableFollow: true });
}
