/**
 * lib/remote-console/approvals: the opt-in remote approval surface for tool
 * calls. When the console server runs, at least one SSE client is connected,
 * and the tool name is listed in remoteControl.approvalTools, a tool_call
 * handler holds the call open, publishes an `approval` event, and waits for
 * POST /approval or the deadline. Fail-open everywhere: a disabled surface,
 * an empty tool list, no console, an error, or an expired hold never blocks
 * a tool call.
 *
 * Handler order vs the bashguard/sys1 tool_call gates is discovery order and
 * cannot be controlled; a gate-blocked call may also be held. Bounded (holds
 * time out) and rare.
 *
 * The terminal cannot resolve these holds: unlike the old bridge, the hold
 * always resolves server-side (console, or deadline expiry).
 */
import { randomUUID } from "node:crypto";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { WireApproval } from "./protocol.ts";

export type ApprovalResolution = "allowed" | "denied" | "expired";

interface PendingHold {
	id: string;
	toolName: string;
	argsPreview: string;
	deadlineMs: number;
	createdAt: string;
	timer: NodeJS.Timeout;
	resolve: (resolution: ApprovalResolution) => void;
}

/** Publishes the wire events a hold produces. Injected so the registry stays
 * free of transport concerns. */
export interface ApprovalPublisher {
	approval(wire: WireApproval): void;
	approvalDone(id: string, resolution: ApprovalResolution): void;
}

export interface ApprovalRegistryOptions {
	publisher: ApprovalPublisher;
	/** Live approval tool list. Empty list: no holds. */
	tools: () => readonly string[];
	/** Connected SSE client count; holds apply only while a console watches. */
	clientCount: () => number;
	/** Hold deadline in milliseconds. */
	timeoutMs: () => number;
}

/** Longest tool-args preview carried on the wire. */
const ARGS_PREVIEW_MAX = 200;

/** JSON preview of a tool call's args, truncated to the wire bound. */
export function argsPreview(args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args) ?? "";
	} catch {
		text = String(args);
	}
	return text.length > ARGS_PREVIEW_MAX ? `${text.slice(0, ARGS_PREVIEW_MAX)}...` : text;
}

function wireApproval(hold: PendingHold): WireApproval {
	return {
		id: hold.id,
		toolName: hold.toolName,
		argsPreview: hold.argsPreview,
		deadlineMs: hold.deadlineMs,
		createdAt: hold.createdAt,
	};
}

export class ApprovalRegistry {
	private holds = new Map<string, PendingHold>();
	private readonly options: ApprovalRegistryOptions;

	constructor(options: ApprovalRegistryOptions) {
		this.options = options;
	}

	/** Hold a tool call when the surface is active. Resolves with the
	 * tool_call result: allowed continues (undefined), denied blocks, expiry
	 * continues. Returns undefined immediately (no hold) when approvals are
	 * disabled, the tool is not listed, no console is connected, or anything
	 * fails - fail-open. */
	async hold(toolName: string, args: unknown): Promise<ToolCallEventResult | undefined> {
		try {
			if (!this.options.tools().includes(toolName)) return undefined;
			if (this.options.clientCount() === 0) return undefined;
			const timeoutMs = this.options.timeoutMs();
			const now = Date.now();
			const id = randomUUID();
			let resolveHold: (resolution: ApprovalResolution) => void = () => undefined;
			const settled = new Promise<ApprovalResolution>((resolve) => {
				resolveHold = resolve;
			});
			const hold: PendingHold = {
				id,
				toolName,
				argsPreview: argsPreview(args),
				deadlineMs: now + timeoutMs,
				createdAt: new Date(now).toISOString(),
				timer: setTimeout(() => this.settle(id, "expired"), timeoutMs),
				resolve: resolveHold,
			};
			hold.timer.unref();
			this.holds.set(id, hold);
			this.options.publisher.approval(wireApproval(hold));
			const resolution = await settled;
			this.options.publisher.approvalDone(id, resolution);
			if (resolution === "denied") {
				return {
					block: true,
					reason: `[remote console] The ${toolName} call was denied from the remote console.`,
				};
			}
			return undefined;
		} catch {
			// Fail-open: a hold must never lose a tool call.
			return undefined;
		}
	}

	/** Resolve a hold from POST /approval. First resolution wins; an id that
	 * is not or no longer pending is "unknown". */
	resolve(id: string, allow: boolean): ApprovalResolution | "unknown" {
		if (!this.holds.has(id)) return "unknown";
		this.settle(id, allow ? "allowed" : "denied");
		return allow ? "allowed" : "denied";
	}

	/** The oldest pending hold, for snapshot payloads. */
	pending(): WireApproval | null {
		for (const hold of this.holds.values()) return wireApproval(hold);
		return null;
	}

	/** Expire every outstanding hold (server shutdown). */
	close(): void {
		for (const id of [...this.holds.keys()]) this.settle(id, "expired");
	}

	private settle(id: string, resolution: ApprovalResolution): void {
		const hold = this.holds.get(id);
		if (!hold) return;
		this.holds.delete(id);
		clearTimeout(hold.timer);
		hold.resolve(resolution);
	}
}
