/**
 * renderer/markdown/Markdown: renders a markdown text block as React elements from the
 * parsed MdBlock tree. Strings are emitted as text nodes only and React escapes all of
 * them, so raw HTML in the source renders as literal escaped text, no element ever
 * carries an untrusted attribute, and links exist only for http, https, and mailto
 * targets (external links open in a new tab with noopener).
 */
/// <reference lib="dom" />
import { useMemo } from "react";
import { capForDisplay, RENDER_CAP_CHARS } from "../display-caps.ts";
import { TruncationNotice } from "../TruncationNotice.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { parseMarkdown, type MdBlock, type MdSpan } from "./parse.ts";

export function Markdown({ text, className }: { text: string; className?: string }) {
	const capped = capForDisplay(text, RENDER_CAP_CHARS);
	const blocks = useMemo(() => parseMarkdown(capped.shown), [capped.shown]);
	return (
		<div className={className === undefined ? "rc-md" : `rc-md ${className}`}>
			{capped.truncated && <TruncationNotice shown={capped.shown.length} total={capped.total} />}
			{blocks.map((block, index) => (
				<BlockView key={index} block={block} />
			))}
		</div>
	);
}

function BlockView({ block }: { block: MdBlock }) {
	switch (block.kind) {
		case "heading": {
			const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			return <Tag className={`rc-md-h rc-md-h${block.level}`}>{spans(block.spans, block.level)}</Tag>;
		}
		case "paragraph":
			return <p className="rc-md-p">{spans(block.spans, "p")}</p>;
		case "code":
			return <CodeBlock language={block.language} code={block.code} closed={block.closed} />;
		case "quote":
			return (
				<blockquote className="rc-md-quote">
					{block.blocks.map((inner, index) => (
						<BlockView key={index} block={inner} />
					))}
				</blockquote>
			);
		case "list": {
			const items = block.items.map((item, index) => (
				<li key={index}>
					{item.task !== null && <span className="rc-md-task">{item.task === "checked" ? "[x] " : "[ ] "}</span>}
					{spans(item.spans, index)}
					{item.blocks.map((inner, innerIndex) => (
						<BlockView key={innerIndex} block={inner} />
					))}
				</li>
			));
			return block.ordered ? (
				<ol className="rc-md-ol" start={block.start}>
					{items}
				</ol>
			) : (
				<ul className="rc-md-ul">{items}</ul>
			);
		}
		case "table":
			return (
				<div className="rc-md-table-wrap">
					<table className="rc-md-table">
						<thead>
							<tr>
								{block.head.map((cell, index) => (
									<th key={index} style={cellAlign(block.align[index])}>
										{spans(cell, index)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex} style={cellAlign(block.align[cellIndex])}>
											{spans(cell, cellIndex)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "rule":
			return <hr className="rc-md-hr" />;
	}
}

function cellAlign(
	align: "left" | "center" | "right" | null | undefined,
): { textAlign: "left" | "center" | "right" } | undefined {
	return align === null || align === undefined ? undefined : { textAlign: align };
}

function spans(spread: readonly MdSpan[], keyBase: number | string) {
	return spread.map((span, index) => (
		<SpanView key={`${keyBase}-${index}`} span={span} depthKey={`${keyBase}-${index}`} />
	));
}

function SpanView({ span, depthKey }: { span: MdSpan; depthKey: string }) {
	switch (span.kind) {
		case "text":
			return <>{span.text}</>;
		case "code":
			return <code className="rc-md-code">{span.text}</code>;
		case "strong":
			return <strong className="rc-md-strong">{spans(span.spans, depthKey)}</strong>;
		case "em":
			return <em className="rc-md-em">{spans(span.spans, depthKey)}</em>;
		case "del":
			return <del className="rc-md-del">{spans(span.spans, depthKey)}</del>;
		case "link":
			return (
				<a className="rc-md-link" href={span.href} target="_blank" rel="noopener noreferrer">
					{span.text}
				</a>
			);
		case "autolink":
			return (
				<a className="rc-md-link" href={span.href} target="_blank" rel="noopener noreferrer">
					{span.href}
				</a>
			);
	}
}
