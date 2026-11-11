/**
 * renderer/TruncationNotice: the explicit marker shown whenever a render cap cut
 * content. Truncation is never silent: the notice names both the shown and the
 * original character counts.
 */
/// <reference lib="dom" />

export function TruncationNotice({ shown, total }: { shown: number; total: number }) {
	return (
		<div className="rc-truncated" data-rc-truncated="true">
			[truncated for display: showing first {shown} of {total} characters]
		</div>
	);
}
