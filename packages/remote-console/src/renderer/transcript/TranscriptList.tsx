/**
 * renderer/transcript/TranscriptList: renders WireTranscriptEntry[] as the virtualized
 * transcript. Rows use content-visibility: auto (renderer.css) with stable entryId keys;
 * happy-dom does not implement content-visibility, so tests observe every row in the DOM
 * and the real render-skipping behavior is verified under Playwright in the hardening
 * phase. Roles are styled distinctly; thinking blocks collapse by default with a toggle;
 * tool results render compact; follow-bottom activates within 96px of the bottom and a
 * jump-to-latest affordance appears otherwise; the live streaming slot renders below the
 * entries and is deduplicated against a frozen entry that has landed in the snapshot.
 */
/// <reference lib="dom" />
import { useEffect, useMemo, useRef, useState } from "react";
import type { WireAgentMessage, WireContentBlock, WireTranscriptEntry } from "../../harness/replay-log.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import type { ToolLiveState, ToolResultView } from "../tool/tool-view.ts";
import { collectToolResults, firstLine, formatDuration } from "../tool/tool-view.ts";
import { ToolCard } from "../tool/ToolCard.tsx";
import { isNearBottom } from "./follow-bottom.ts";
import type { LiveSlot, LiveSlotBlock } from "./stream-slot.ts";
import "../renderer.css";

export function TranscriptList({
	entries,
	slot,
	toolUpdates,
}: {
	entries: readonly WireTranscriptEntry[];
	slot?: LiveSlot | null;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
}) {
	const results = useMemo(() => collectToolResults(entries), [entries]);
	const entryIds = useMemo(() => new Set(entries.map((entry) => entry.entryId)), [entries]);
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const [nearBottom, setNearBottom] = useState(true);
	// Direct scroll listener: scroll does not bubble, and React's delegated handler is not
	// reliable across environments (happy-dom dispatches do not reach it).
	useEffect(() => {
		const element = scrollerRef.current;
		if (element === null) return;
		const handler = () => {
			setNearBottom(isNearBottom(element.scrollTop, element.clientHeight, element.scrollHeight));
		};
		element.addEventListener("scroll", handler);
		return () => element.removeEventListener("scroll", handler);
	}, []);
	// Follow the bottom when already near it; effects run after entries or slot content change.
	useEffect(() => {
		if (!nearBottom) return;
		const element = scrollerRef.current;
		if (element !== null) element.scrollTop = element.scrollHeight;
	}, [entries, slot, nearBottom]);
	const slotVisible = slot !== undefined && slot !== null && !(slot.frozen && slot.entryId !== null && entryIds.has(slot.entryId));
	return (
		<div className="rc-transcript-list" data-rc-scroller="true" ref={scrollerRef}>
			{entries.map((entry) => (
				<EntryRow key={entry.entryId} entry={entry} results={results} toolUpdates={toolUpdates} />
			))}
			{slotVisible && <SlotRow key={slot.entryId ?? slot.slotKey} slot={slot} results={results} toolUpdates={toolUpdates} />}
			{!nearBottom && (
				<button
					type="button"
					className="rc-jump"
					data-rc-jump="true"
					onClick={() => {
						const element = scrollerRef.current;
						if (element !== null) element.scrollTop = element.scrollHeight;
					}}
				>
					Jump to latest
				</button>
			)}
		</div>
	);
}

function EntryRow({
	entry,
	results,
	toolUpdates,
}: {
	entry: WireTranscriptEntry;
	results: ReadonlyMap<string, ToolResultView>;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
}) {
	const message = entry.message;
	if (message.role === "toolResult") {
		return <ToolResultRow entryId={entry.entryId} message={message} />;
	}
	const className = `rc-entry rc-msg rc-msg-${message.role}`;
	return (
		<article className={className} data-entry-id={entry.entryId} data-rc-role={message.role}>
			<RoleTag role={message.role} />
			<BlocksView
				blocks={message.blocks}
				results={results}
				toolUpdates={toolUpdates}
				thinking={message.role === "assistant" || message.role === "custom"}
			/>
		</article>
	);
}

function SlotRow({
	slot,
	results,
	toolUpdates,
}: {
	slot: LiveSlot;
	results: ReadonlyMap<string, ToolResultView>;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
}) {
	const streaming = !slot.frozen;
	return (
		<article
			className={`rc-entry rc-msg rc-msg-${slot.role}${streaming ? " rc-streaming" : ""}`}
			data-entry-id={slot.entryId ?? undefined}
			data-rc-role={slot.role}
			data-rc-streaming={streaming ? "true" : undefined}
		>
			<RoleTag role={slot.role} />
			<BlocksView blocks={slot.blocks} results={results} toolUpdates={toolUpdates} thinking />
		</article>
	);
}

function RoleTag({ role }: { role: WireAgentMessage["role"] }) {
	if (role === "assistant") return null;
	return <div className="rc-role-tag">{role}</div>;
}

function BlocksView({
	blocks,
	results,
	toolUpdates,
	thinking,
}: {
	blocks: readonly WireContentBlock[];
	results: ReadonlyMap<string, ToolResultView>;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
	thinking: boolean;
}) {
	return (
		<div className="rc-msg-blocks">
			{blocks.map((block, index) => (
				<BlockView key={index} block={block} results={results} toolUpdates={toolUpdates} thinking={thinking} />
			))}
		</div>
	);
}

function BlockView({
	block,
	results,
	toolUpdates,
	thinking,
}: {
	block: WireContentBlock;
	results: ReadonlyMap<string, ToolResultView>;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
	thinking: boolean;
}) {
	switch (block.type) {
		case "text":
			return <Markdown text={block.text} />;
		case "thinking":
			return thinking && block.text !== "" ? (
				<ThinkingBlock text={block.text} />
			) : (
				<Markdown text={block.text} className="rc-md-thinking" />
			);
		case "toolCall":
			return <ToolCard call={block} result={results.get(block.id)} live={toolUpdates?.get(block.id)} />;
		case "imageElided":
			return <div className="rc-elided">image not transported over the wire</div>;
	}
}

function ThinkingBlock({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rc-thinking" data-rc-thinking={open ? "open" : "closed"}>
			<button type="button" className="rc-thinking-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
				thinking ({text.length} characters){open ? " - hide" : " - show"}
			</button>
			{open && <Markdown text={text} className="rc-md-thinking" />}
		</div>
	);
}

function ToolResultRow({ entryId, message }: { entryId: string; message: WireAgentMessage }) {
	const text = blocksText(message);
	const isError = message.isError === true;
	const duration = message.durationMs !== undefined ? formatDuration(message.durationMs) : "";
	return (
		<article
			className={`rc-entry rc-toolresult${isError ? " rc-toolresult-error" : ""}`}
			data-entry-id={entryId}
			data-rc-role="toolResult"
			data-rc-result-state={isError ? "error" : "done"}
		>
			<span className="rc-tool-glyph" aria-hidden="true">
				{isError ? "✗" : "✓"}
			</span>
			<span className="rc-tool-state">{isError ? "error" : "done"}</span>
			<span className="rc-tool-name">{message.toolName ?? "tool result"}</span>
			<span className="rc-tool-preview">{firstLine(text)}</span>
			{duration !== "" && <span className="rc-tool-duration">{duration}</span>}
		</article>
	);
}

function blocksText(message: { blocks: readonly LiveSlotBlock[] }): string {
	const parts: string[] = [];
	for (const block of message.blocks) {
		if (block.type === "text" || block.type === "thinking") parts.push(block.text);
	}
	return parts.join("\n");
}
