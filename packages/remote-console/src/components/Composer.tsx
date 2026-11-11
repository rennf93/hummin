/**
 * components/Composer: prompt input and run control for the active host.
 * Textarea (12000 chars, the server's cap), steer vs followUp delivery as a
 * sliding-pill segmented control (followUp default), send and abort actions,
 * and the console-tracked queue (what this console sent while the agent was
 * busy) with the honest terminal count the extension cannot read.
 */
/// <reference lib="dom" />
import { useState } from "react";
import type { WireQueue } from "../harness/replay-log.ts";
import { SlidingPill, type PillButtonProps } from "./SlidingPill.tsx";

/** The server rejects prompts above 12000 characters (PROMPT_MAX_CHARS). */
const PROMPT_MAX_CHARS = 12_000;

const DELIVERY_MODES = ["followUp", "steer"] as const;

/** Test hook attributes for the delivery pill's option buttons. */
function deliveryProps(mode: (typeof DELIVERY_MODES)[number]): PillButtonProps {
	return { "data-rc-deliver-mode": mode };
}

export function Composer({
	queue,
	disabled,
	onSend,
	onAbort,
}: {
	queue: WireQueue | null;
	disabled: boolean;
	onSend(text: string, deliverAs: "steer" | "followUp"): void;
	onAbort(): void;
}) {
	const [text, setText] = useState("");
	const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("followUp");
	const ready = !disabled && text.trim() !== "";
	const send = () => {
		if (!ready) return;
		onSend(text, deliverAs);
		setText("");
	};
	const items = queue?.items ?? [];
	const terminalQueued = queue?.terminalQueued ?? 0;
	return (
		<div className="rc-composer-inner" data-rc-composer="true">
			{items.length > 0 && (
				<ul className="rc-queue" data-rc-queue="true">
					{items.map((item) => (
						<li key={item.id} className="rc-queue-item" data-rc-queue-item={item.id}>
							<span className="rc-queue-deliver" data-rc-queue-deliver={item.deliverAs}>
								{item.deliverAs === "steer" ? "steer" : "follow-up"}
							</span>
							<span className="rc-queue-preview">{item.preview}</span>
						</li>
					))}
				</ul>
			)}
			{terminalQueued > 0 && <div className="rc-queue-terminal" data-rc-queue-terminal="true">{terminalQueued} queued in terminal</div>}
			<div className="rc-composer-row">
				<textarea
					className="rc-composer-input"
					data-rc-composer-input="true"
					aria-label="prompt"
					placeholder={disabled ? "select a connected host" : "message the agent"}
					value={text}
					maxLength={PROMPT_MAX_CHARS}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							send();
						}
					}}
				/>
				<span className="rc-deliver" data-rc-deliver-as={deliverAs}>
					<SlidingPill
						options={DELIVERY_MODES.map((mode) => ({
							value: mode,
							label: mode === "steer" ? "steer" : "follow-up",
							props: deliveryProps(mode),
						}))}
						active={deliverAs}
						onChange={setDeliverAs}
						ariaLabel="delivery mode"
					/>
				</span>
				<button type="button" className="rc-composer-send" data-rc-send="true" disabled={!ready} onClick={send}>
					send
				</button>
				<button type="button" className="rc-composer-abort" data-rc-abort="true" disabled={disabled} onClick={onAbort}>
					abort
				</button>
			</div>
		</div>
	);
}
