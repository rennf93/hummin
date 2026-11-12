/**
 * renderer/transcript/EntryRow: one transcript entry or the live slot as a row.
 * user is a soft bubble, assistant is plain prose, system and custom are quiet
 * one-line notices that expand when long (typed by customType when set, with an
 * optional repeat count for collapsed identical neighbours), and an orphan toolResult (no matching
 * toolCall anywhere) is a quiet tool-style row. Consecutive tool calls in a message
 * form one tight group; thinking is a Disclosure; the live slot's last text block is
 * paced by useSmoothText. EntryRow is memoized so a streaming slot update re-renders
 * only the slot row.
 */
/// <reference lib="dom" />
import { memo, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import type { WireAgentMessage, WireContentBlock, WireTranscriptEntry } from "../../harness/replay-log.ts";
import { Disclosure } from "../../ui/Disclosure.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Shimmer } from "../../ui/Shimmer.tsx";
import { useSmoothText } from "../../ui/useSmoothText.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { STATE_ICON, STATE_LABEL, ToolCard } from "../tool/ToolCard.tsx";
import type { ToolLiveState, ToolResultView } from "../tool/tool-view.ts";
import { firstLine, formatDuration, specializeTool, toolVerb } from "../tool/tool-view.ts";
import { blocksText, type NoticeParts, noticeParts } from "./notice.ts";
import type { LiveSlot, LiveSlotBlock } from "./stream-slot.ts";

type ToolMaps = {
	results?: ReadonlyMap<string, ToolResultView>;
	toolUpdates?: ReadonlyMap<string, ToolLiveState>;
};

/** Longest single-line notice shown without a disclosure. */
const NOTICE_INLINE_MAX = 140;

export const EntryRow = memo(function EntryRow({
	entry,
	arrived,
	results,
	toolUpdates,
	repeat,
}: { entry: WireTranscriptEntry; arrived: boolean; repeat?: number } & ToolMaps) {
	const message = entry.message;
	if (message.role === "toolResult") {
		return <ToolResultRow entryId={entry.entryId} message={message} arrived={arrived} />;
	}
	return (
		<article
			className={rowClass(message.role, message.blocks, arrived)}
			data-entry-id={entry.entryId}
			data-rc-role={message.role}
			data-rc-arrived={arrived ? "true" : undefined}
			data-rc-repeat={repeat}
		>
			<MessageContent
				role={message.role}
				blocks={message.blocks}
				customType={message.customType}
				details={message.details}
				repeat={repeat}
				results={results}
				toolUpdates={toolUpdates}
				thinking={message.role === "assistant" || message.role === "custom"}
				streaming={false}
			/>
			<MessageMeta
				role={message.role}
				blocks={message.blocks}
				usage={message.usage}
				durationMs={message.durationMs}
			/>
		</article>
	);
});

export const SlotRow = memo(function SlotRow({
	slot,
	results,
	toolUpdates,
	repeat,
}: { slot: LiveSlot; repeat?: number } & ToolMaps) {
	const streaming = !slot.frozen;
	return (
		<article
			className={rowClass(slot.role, slot.blocks, false) + (streaming ? " rc-streaming" : "")}
			data-entry-id={slot.entryId ?? undefined}
			data-rc-role={slot.role}
			data-rc-streaming={streaming ? "true" : undefined}
			aria-busy={streaming ? "true" : undefined}
			data-rc-repeat={repeat}
		>
			<MessageContent
				role={slot.role}
				blocks={slot.blocks}
				customType={slot.customType}
				details={slot.details}
				repeat={repeat}
				results={results}
				toolUpdates={toolUpdates}
				thinking
				streaming={streaming}
			/>
			{!streaming && (
				<MessageMeta role={slot.role} blocks={slot.blocks} usage={slot.usage} durationMs={slot.durationMs} />
			)}
		</article>
	);
});

/** One quiet footer line under a finished assistant message that has text: output tokens, duration, rate. */
function MessageMeta({
	role,
	blocks,
	usage,
	durationMs,
}: {
	role: WireAgentMessage["role"];
	blocks: readonly WireContentBlock[];
	usage?: WireAgentMessage["usage"];
	durationMs?: number;
}) {
	if (role !== "assistant" || !blocks.some((block) => block.type === "text" && block.text !== "")) return null;
	const parts: string[] = [];
	if (usage !== undefined) parts.push(`${usage.output} tok`);
	if (durationMs !== undefined) parts.push(formatDuration(durationMs));
	if (usage !== undefined && durationMs !== undefined && durationMs > 0) {
		parts.push(`${(usage.output / (durationMs / 1000)).toFixed(1)} tok/s`);
	}
	if (parts.length === 0) return null;
	return (
		<div className="rc-msg-meta" data-rc-msg-meta="true">
			{parts.join(" \u00b7 ")}
		</div>
	);
}

function rowClass(role: WireAgentMessage["role"], blocks: readonly LiveSlotBlock[], arrived: boolean): string {
	const toolsOnly = blocks.length > 0 && blocks.every((block) => block.type === "toolCall");
	return `rc-entry rc-msg rc-msg-${role}${toolsOnly ? " rc-msg-tools" : ""}${arrived ? " rc-enter" : ""}`;
}

function MessageContent({
	role,
	blocks,
	results,
	toolUpdates,
	thinking,
	streaming,
	customType,
	details,
	repeat,
}: {
	role: WireAgentMessage["role"];
	blocks: readonly WireContentBlock[];
	thinking: boolean;
	streaming: boolean;
	customType?: string;
	details?: Record<string, unknown>;
	repeat?: number;
} & ToolMaps) {
	const body = (
		<BlocksView
			blocks={blocks}
			results={results}
			toolUpdates={toolUpdates}
			thinking={thinking}
			streaming={streaming}
		/>
	);
	if (role === "system" || role === "custom") {
		return (
			<Notice role={role} blocks={blocks} body={body} customType={customType} details={details} repeat={repeat} />
		);
	}
	return body;
}

function Notice({
	role,
	blocks,
	body,
	customType,
	details,
	repeat,
}: {
	role: "system" | "custom";
	blocks: readonly WireContentBlock[];
	body: ReactNode;
	customType?: string;
	details?: Record<string, unknown>;
	repeat?: number;
}) {
	const [open, setOpen] = useState(false);
	const [clipped, setClipped] = useState(false);
	const bodyId = useId();
	const textRef = useRef<HTMLSpanElement | null>(null);
	const text = blocksText(blocks);
	const summary = firstLine(text.replace(/^#{1,6}\s+/, ""), NOTICE_INLINE_MAX);
	const parts = noticeParts(role, customType, details);
	// shortcut: once a notice has been seen clipped it keeps its toggle, even if a wider
	// pane would now fit it; flipping back and forth would resize the text it measures.
	const expandable =
		clipped ||
		text.includes("\n") ||
		text.length > NOTICE_INLINE_MAX ||
		blocks.some((block) => block.type !== "text");
	// The collapsed text clamps at three lines in CSS; a clamped notice must be expandable.
	// biome-ignore lint/correctness/useExhaustiveDependencies: text is a re-measure trigger; the effect reads the DOM
	useLayoutEffect(() => {
		const element = textRef.current;
		if (element === null || clipped) return;
		const measure = () => {
			if (element.scrollHeight > element.clientHeight + 1) setClipped(true);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [clipped, text]);
	const content = (
		<>
			<Icon name={parts.icon} />
			<span className="rc-notice-text" ref={textRef}>
				<NoticeLead parts={parts} />
				{summary}
			</span>
			{repeat !== undefined && <span className="rc-notice-repeat">x{repeat}</span>}
		</>
	);
	if (!expandable) {
		return (
			<div className="rc-notice" data-rc-custom-type={customType}>
				<span className="rc-notice-row">{content}</span>
			</div>
		);
	}
	return (
		<div className="rc-notice" data-open={open ? "true" : "false"} data-rc-custom-type={customType}>
			<button
				type="button"
				className="rc-notice-row rc-notice-toggle"
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				onClick={() => setOpen(!open)}
			>
				{content}
				<Icon name="chevron-right" className="rc-chevron" />
			</button>
			<Disclosure open={open}>
				<div className="rc-notice-body" id={bodyId}>
					{body}
				</div>
			</Disclosure>
		</div>
	);
}

/** Label, state and duration ahead of the message text; each piece ends with a space. */
function NoticeLead({ parts }: { parts: NoticeParts }) {
	return (
		<>
			{parts.lead !== undefined && parts.lead}
			{parts.label !== undefined && <span className="rc-label">{parts.label} </span>}
			{parts.detail !== undefined && `${parts.detail} `}
			{parts.state !== undefined && `${parts.state} `}
			{parts.duration !== undefined && <span className="rc-mono">{parts.duration} </span>}
			{parts.exit !== undefined && <span className="rc-notice-bad">{parts.exit} </span>}
		</>
	);
}

function BlocksView({
	blocks,
	results,
	toolUpdates,
	thinking,
	streaming,
}: {
	blocks: readonly WireContentBlock[];
	thinking: boolean;
	streaming: boolean;
} & ToolMaps) {
	const lastIndex = blocks.length - 1;
	const lastTextIndex = blocks.findLastIndex((block) => block.type === "text");
	const nodes: ReactNode[] = [];
	let index = 0;
	while (index < blocks.length) {
		const block = blocks[index];
		if (block === undefined) break;
		if (block.type === "toolCall") {
			const start = index;
			const group: ReactNode[] = [];
			for (let next = blocks[index]; next?.type === "toolCall"; next = blocks[index]) {
				group.push(
					<ToolCard key={index} call={next} result={results?.get(next.id)} live={toolUpdates?.get(next.id)} />,
				);
				index += 1;
			}
			nodes.push(
				<div className="rc-tool-group" key={`group-${start}`}>
					{group}
				</div>,
			);
			continue;
		}
		nodes.push(
			<BlockView
				key={index}
				block={block}
				thinking={thinking}
				smooth={streaming && index === lastTextIndex}
				liveThinking={streaming && index === lastIndex}
			/>,
		);
		index += 1;
	}
	return <div className="rc-msg-blocks">{nodes}</div>;
}

function BlockView({
	block,
	thinking,
	smooth,
	liveThinking,
}: {
	block: WireContentBlock;
	thinking: boolean;
	smooth: boolean;
	liveThinking: boolean;
}) {
	switch (block.type) {
		case "text":
			return smooth ? <SmoothMarkdown text={block.text} /> : <Markdown text={block.text} />;
		case "thinking":
			if (thinking && (block.text !== "" || liveThinking))
				return <ThinkingBlock text={block.text} live={liveThinking} />;
			return block.text === "" ? null : <Markdown text={block.text} className="rc-md-thinking" />;
		case "toolCall":
			return null;
		case "imageElided":
			return <div className="rc-elided">image not transported over the wire</div>;
	}
}

/** The one place the smoothing hook runs: only the live slot's last text block. */
function SmoothMarkdown({ text }: { text: string }) {
	return <Markdown text={useSmoothText(text, true)} />;
}

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	return (
		<div className="rc-thinking" data-rc-thinking={open ? "open" : "closed"}>
			<button
				type="button"
				className="rc-thinking-toggle"
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				onClick={() => setOpen(!open)}
			>
				{live ? <Shimmer>Thinking</Shimmer> : "Thought"}
				<Icon name="chevron-right" className="rc-chevron" />
			</button>
			<Disclosure open={open}>
				<div id={bodyId}>
					<Markdown text={text} className="rc-md-thinking" />
				</div>
			</Disclosure>
		</div>
	);
}

function ToolResultRow({
	entryId,
	message,
	arrived,
}: {
	entryId: string;
	message: WireAgentMessage;
	arrived: boolean;
}) {
	const isError = message.isError === true;
	const kind = isError ? "error" : "completed";
	const name = message.toolName ?? "tool result";
	const duration = message.durationMs !== undefined ? formatDuration(message.durationMs) : "";
	return (
		<article
			className={`rc-entry rc-toolresult${isError ? " rc-toolresult-error" : ""}${arrived ? " rc-enter" : ""}`}
			data-entry-id={entryId}
			data-rc-role="toolResult"
			data-rc-result-state={isError ? "error" : "done"}
			data-rc-arrived={arrived ? "true" : undefined}
		>
			<div className="rc-tool-row rc-tool-row-static">
				<span className="rc-tool-glyph">
					<Icon name={STATE_ICON[kind]} />
				</span>
				<span className="rc-tool-state">{STATE_LABEL[kind]}</span>
				<span className="rc-tool-name">{toolVerb(specializeTool(name, {}).kind, kind, name)}</span>
				<span className="rc-tool-preview">{firstLine(blocksText(message.blocks))}</span>
				{duration !== "" && <span className="rc-tool-duration">{duration}</span>}
			</div>
		</article>
	);
}
