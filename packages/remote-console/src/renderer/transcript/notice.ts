/**
 * renderer/transcript/notice: pure view model for system and custom notices.
 * Known hummin extension customTypes become typed notices (icon, label, state);
 * details come off the wire untrusted, so every field is narrowed. The signature
 * identifies what a notice shows, so the list can collapse adjacent repeats.
 */
import type { WireAgentMessage, WireContentBlock } from "../../harness/replay-log.ts";
import type { IconName } from "../../ui/Icon.tsx";
import { formatDuration } from "../tool/tool-view.ts";

export interface NoticeParts {
	icon: IconName;
	/** Plain lead text (the memory recall sentence). */
	lead?: string;
	/** Small `.rc-label` prefix. */
	label?: string;
	/** Free text next to the label (a task's own label). */
	detail?: string;
	state?: string;
	duration?: string;
	/** "exit N" for a non-zero exit code; shown as a word, not colour alone. */
	exit?: string;
}

export function blocksText(blocks: readonly WireContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text" || block.type === "thinking") parts.push(block.text);
	}
	return parts.join("\n");
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = details?.[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = details?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function noticeParts(
	role: "system" | "custom",
	customType: string | undefined,
	details: Record<string, unknown> | undefined,
): NoticeParts {
	switch (customType) {
		case undefined:
			return { icon: role === "system" ? "file" : "sparkle" };
		case "hummin-memory-recall": {
			const count = numberDetail(details, "lessonCount");
			const lead =
				count === undefined
					? "Recalled lessons from memory"
					: `Recalled ${count} ${count === 1 ? "lesson" : "lessons"} from memory`;
			return { icon: "sparkle", lead };
		}
		case "hummin-monitor":
			return { icon: "clock", label: "Monitor" };
		case "hummin-exec":
			return { icon: "terminal", label: "Exec" };
		case "hummin-task": {
			const duration = numberDetail(details, "durationMs");
			const exitCode = numberDetail(details, "exitCode");
			return {
				icon: "task",
				label: "Task",
				detail: stringDetail(details, "label"),
				state: stringDetail(details, "state"),
				duration: duration === undefined ? undefined : formatDuration(duration),
				exit: exitCode === undefined || exitCode === 0 ? undefined : `exit ${exitCode}`,
			};
		}
		default:
			return { icon: "sparkle", label: customType };
	}
}

/** Same signature means same visible notice; undefined means never merge (not a
 * notice, or it carries non-text blocks). */
export function noticeSignature(message: WireAgentMessage): string | undefined {
	if (message.role !== "system" && message.role !== "custom") return undefined;
	if (message.blocks.some((block) => block.type !== "text")) return undefined;
	return JSON.stringify([
		message.role,
		message.customType,
		noticeParts(message.role, message.customType, message.details),
		blocksText(message.blocks),
	]);
}
