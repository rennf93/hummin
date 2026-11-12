/**
 * ui/SessionId: the short session id (first 8 characters, mono, faint). Click or
 * Enter/Space copies the full id and confirms with "Copied" through a polite
 * live region. A clipboard failure is silent.
 */
import { useEffect, useRef, useState } from "react";

const COPIED_MS = 1500;

export function SessionId({ id }: { id: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	if (id === "") return null;

	const copy = () => {
		// the Promise wrapper also catches a missing clipboard (insecure context)
		Promise.resolve()
			.then(() => navigator.clipboard.writeText(id))
			.then(
				() => {
					setCopied(true);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => setCopied(false), COPIED_MS);
				},
				() => {},
			);
	};

	return (
		<>
			<button type="button" className="rc-session-id" aria-label={`Copy session id ${id}`} title={id} onClick={copy}>
				{copied ? "Copied" : id.slice(0, 8)}
			</button>
			<span className="rc-sr-only" aria-live="polite">
				{copied ? "Copied" : ""}
			</span>
		</>
	);
}
