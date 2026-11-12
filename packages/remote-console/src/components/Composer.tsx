/**
 * components/Composer: prompt input and run control for the active host.
 * One rounded container: a borderless autosizing textarea (12000 chars, the
 * server's cap) over a bottom row with the steer vs followUp delivery pill
 * (followUp default), the stop action (present only while the agent works) and
 * send. Enter sends, Shift+Enter inserts a newline, Cmd/Ctrl+Enter also sends.
 * The console-tracked queue (what this console sent while the agent was busy)
 * sits above the textarea with the honest terminal count the extension cannot
 * read.
 */
/// <reference lib="dom" />
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ActionResult, describeSendFailure } from "../connection.ts";
import type { WireQueue } from "../harness/replay-log.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { usePresence } from "../ui/usePresence.ts";
import { type PillButtonProps, SlidingPill } from "./SlidingPill.tsx";

/** The server rejects prompts above 12000 characters (PROMPT_MAX_CHARS). */
const PROMPT_MAX_CHARS = 12_000;

const DELIVERY_MODES = ["followUp", "steer"] as const;

/** Test hook attributes for the delivery pill's option buttons. */
function deliveryProps(mode: (typeof DELIVERY_MODES)[number]): PillButtonProps {
	return { "data-rc-deliver-mode": mode };
}

/** What one host's composer holds between visits: draft, mode, and the last failure. */
interface Draft {
	text: string;
	deliverAs: "steer" | "followUp";
	sending: boolean;
	aborting: boolean;
	error: string | null;
}

const EMPTY_DRAFT: Draft = { text: "", deliverAs: "followUp", sending: false, aborting: false, error: null };

export function Composer({
	hostId,
	queue,
	disabled,
	disabledReason,
	working = false,
	onSend,
	onAbort,
}: {
	/** Drafts are kept per host: switching hosts swaps the text and delivery mode. */
	hostId: string;
	queue: WireQueue | null;
	disabled: boolean;
	/** Placeholder text naming why the composer is disabled. */
	disabledReason?: string;
	/** The stop action is offered (DESIGN.md motion 12). */
	working?: boolean;
	onSend(text: string, deliverAs: "steer" | "followUp"): Promise<ActionResult>;
	onAbort(): Promise<ActionResult>;
}) {
	const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
	const draft = drafts[hostId] ?? EMPTY_DRAFT;
	const { text, deliverAs, sending, aborting, error } = draft;
	const patchDraft = (id: string, patch: Partial<Draft>): void =>
		setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_DRAFT), ...patch } }));
	const setText = (next: string): void => patchDraft(hostId, { text: next, error: null });
	const setDeliverAs = (next: "steer" | "followUp"): void => patchDraft(hostId, { deliverAs: next });
	const input = useRef<HTMLTextAreaElement | null>(null);
	const stop = usePresence(working);
	const ready = !disabled && !sending && text.trim() !== "";
	// Autosize: collapse first so scrollHeight shrinks with deleted lines; the
	// css max-height (40vh) caps growth and the textarea scrolls beyond it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: text and hostId are re-fit triggers; the effect reads the DOM, not them
	useLayoutEffect(() => {
		const fitHeight = (): void => {
			const node = input.current;
			if (node === null) return;
			node.style.height = "auto";
			node.style.height = `${node.scrollHeight}px`;
		};
		fitHeight();
		// A width change rewraps the text: a height measured at another width is stale.
		window.addEventListener("resize", fitHeight);
		return () => window.removeEventListener("resize", fitHeight);
	}, [text, hostId]);
	// iOS keeps innerHeight when the keyboard opens: expose the covered height so the dock can clear it.
	useEffect(() => {
		const viewport = window.visualViewport;
		// Absent in older browsers and some test DOMs.
		if (!viewport) return;
		const root = document.documentElement;
		let frame = 0;
		const update = (): void => {
			if (frame !== 0) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
				root.style.setProperty("--rc-keyboard-inset", `${inset}px`);
			});
		};
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			cancelAnimationFrame(frame);
			root.style.removeProperty("--rc-keyboard-inset");
		};
	}, []);
	const send = async (): Promise<void> => {
		if (!ready) return;
		const target = hostId;
		patchDraft(target, { sending: true, error: null });
		const result = await onSend(text, deliverAs);
		// Success clears the draft; failure keeps the text and says why.
		patchDraft(
			target,
			result.ok ? { text: "", sending: false } : { sending: false, error: describeSendFailure(result) },
		);
	};
	const abort = async (): Promise<void> => {
		const target = hostId;
		patchDraft(target, { aborting: true });
		const result = await onAbort();
		patchDraft(target, {
			aborting: false,
			error: result.ok ? null : describeSendFailure(result).replace("Not sent", "Stop not sent"),
		});
	};
	const items = queue?.items ?? [];
	const terminalQueued = queue?.terminalQueued ?? 0;
	return (
		<div className="rc-composer-inner" data-rc-composer="true" data-rc-disabled={disabled ? "true" : undefined}>
			{items.length > 0 && (
				<ul className="rc-queue" data-rc-queue="true">
					{items.map((item) => (
						<li key={item.id} className="rc-queue-item rc-enter" data-rc-queue-item={item.id}>
							<span className="rc-queue-deliver rc-label" data-rc-queue-deliver={item.deliverAs}>
								{item.deliverAs === "steer" ? "steer" : "follow-up"}
							</span>
							<span className="rc-queue-preview">{item.preview}</span>
						</li>
					))}
				</ul>
			)}
			{terminalQueued > 0 && (
				<div className="rc-queue-terminal" data-rc-queue-terminal="true">
					{terminalQueued} queued in terminal
				</div>
			)}
			<textarea
				ref={input}
				className="rc-composer-input"
				data-rc-composer-input="true"
				aria-label="prompt"
				rows={1}
				placeholder={disabled ? (disabledReason ?? "select a connected host") : "message the agent"}
				disabled={disabled}
				value={text}
				maxLength={PROMPT_MAX_CHARS}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (event.shiftKey && !event.ctrlKey && !event.metaKey) return;
					event.preventDefault();
					void send();
				}}
			/>
			{error !== null && (
				<div className="rc-composer-error" role="alert" data-rc-send-error="true">
					{error}
				</div>
			)}
			<div className="rc-composer-row">
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
						disabled={disabled}
					/>
				</span>
				<span className="rc-composer-actions">
					{stop.mounted && (
						<Button
							icon="stop"
							aria-label="Stop"
							title="Stop"
							variant="danger"
							className="rc-composer-abort"
							data-rc-state={stop.state}
							data-rc-abort="true"
							busy={aborting}
							disabled={disabled}
							onClick={() => void abort()}
						>
							<span className="rc-composer-abort-label">Stop</span>
						</Button>
					)}
					<IconButton
						icon="arrow-up"
						label="send"
						variant="primary"
						className="rc-composer-send rc-pressable"
						data-rc-send="true"
						busy={sending}
						disabled={disabled || (!sending && text.trim() === "")}
						onClick={() => void send()}
					/>
				</span>
			</div>
		</div>
	);
}
