/**
 * renderer/markdown/CodeBlock: a fenced code block. Language label on the header row,
 * pre-wrapped monospace body, no syntax highlighting in this phase (bundle budget),
 * render-capped with an explicit notice. Unclosed fences say so.
 */
/// <reference lib="dom" />
import { capForDisplay, RENDER_CAP_CHARS } from "../display-caps.ts";
import { TruncationNotice } from "../TruncationNotice.tsx";

export function CodeBlock({ language, code, closed }: { language: string; code: string; closed: boolean }) {
	const capped = capForDisplay(code, RENDER_CAP_CHARS);
	return (
		<pre className="rc-code">
			<div className="rc-code-head">
				<span className="rc-code-lang">{language === "" ? "text" : language}</span>
				{!closed && <span className="rc-code-unclosed">fence not closed</span>}
				{capped.truncated && <TruncationNotice shown={capped.shown.length} total={capped.total} />}
			</div>
			<code className="rc-code-body">{capped.shown}</code>
		</pre>
	);
}
