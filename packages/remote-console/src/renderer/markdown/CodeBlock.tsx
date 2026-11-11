/**
 * renderer/markdown/CodeBlock: a fenced code block. Slim header with the language and a
 * copy button, horizontally scrolling monospace body (no wrapping), no syntax
 * highlighting in this phase (bundle budget), render-capped with an explicit notice.
 * Unclosed fences say so. Copy writes the full source, not the display-capped text.
 */
/// <reference lib="dom" />
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../ui/Button.tsx";
import { capForDisplay, RENDER_CAP_CHARS } from "../display-caps.ts";
import { TruncationNotice } from "../TruncationNotice.tsx";

const COPY_FEEDBACK_MS = 1500;

type CopyStatus = "idle" | "copied" | "failed";

const COPY_ICON = { idle: "copy", copied: "check", failed: "x" } as const;
const COPY_LABEL = { idle: "Copy code", copied: "Copied", failed: "Copy failed" } as const;

/** Plain http LAN origins have no navigator.clipboard: select a hidden textarea and use the legacy command. */
function copyThroughTextarea(text: string): boolean {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.top = "0";
	area.style.left = "0";
	area.style.opacity = "0";
	const previous = document.activeElement;
	document.body.appendChild(area);
	try {
		area.select();
		area.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		area.remove();
		if (previous instanceof HTMLElement) previous.focus();
	}
}

async function writeToClipboard(text: string): Promise<boolean> {
	const clipboard = navigator.clipboard as Clipboard | undefined;
	if (clipboard !== undefined) {
		try {
			await clipboard.writeText(text);
			return true;
		} catch {
			// fall through to the textarea path
		}
	}
	return copyThroughTextarea(text);
}

export function CodeBlock({ language, code, closed }: { language: string; code: string; closed: boolean }) {
	const capped = capForDisplay(code, RENDER_CAP_CHARS);
	const [status, setStatus] = useState<CopyStatus>("idle");
	const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(resetTimer.current), []);
	const copy = async () => {
		const ok = await writeToClipboard(code);
		setStatus(ok ? "copied" : "failed");
		clearTimeout(resetTimer.current);
		resetTimer.current = setTimeout(() => setStatus("idle"), COPY_FEEDBACK_MS);
	};
	return (
		<div className="rc-code">
			<div className="rc-code-head">
				<span className="rc-label rc-code-lang">{language === "" ? "text" : language}</span>
				{!closed && <span className="rc-code-unclosed">fence not closed</span>}
				<IconButton
					className="rc-code-copy"
					icon={COPY_ICON[status]}
					label={COPY_LABEL[status]}
					size="sm"
					onClick={copy}
				/>
				<span className="rc-sr-only" aria-live="polite">
					{status === "idle" ? "" : COPY_LABEL[status]}
				</span>
			</div>
			<pre className="rc-code-pre">
				<code className="rc-code-body">{capped.shown}</code>
			</pre>
			{capped.truncated && <TruncationNotice shown={capped.shown.length} total={capped.total} />}
		</div>
	);
}
