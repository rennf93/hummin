/**
 * renderer/transcript/follow-bottom: the dashboard scroll rule for the transcript.
 * Auto-follow is on only while the viewport is within the threshold of the bottom;
 * otherwise new content must not steal the reader's scroll position, and a
 * jump-to-latest affordance appears instead.
 */

export const FOLLOW_THRESHOLD_PX = 96;

/** True when the scroll viewport is within thresholdPx of the bottom. */
export function isNearBottom(
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	thresholdPx: number = FOLLOW_THRESHOLD_PX,
): boolean {
	return scrollHeight - (scrollTop + clientHeight) <= thresholdPx;
}
