/**
 * lib/remote-console/index: extension-side remote console entry point.
 * startRemoteConsole(pi, options) wires the pi event source, the approval
 * surface, the origin store, and the HTTP server into one handle; the
 * hummin-remote extension calls it from /remote-control and keeps the status
 * line, the usage notify, and the console-tracked queue honest.
 *
 * Config resolution (env beats settings, settings beat defaults) lives here:
 * HUMMIN_REMOTE=off kills the endpoint, HUMMIN_REMOTE_HOST picks the bind
 * address (non-loopback needs remoteControl.allowLan: true AND
 * HUMMIN_REMOTE_LAN != off), HUMMIN_REMOTE_PORT / remoteControl.port pick the
 * port (default 0, ephemeral).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { ApprovalRegistry } from "./approvals.ts";
import {
	ConsoleEventSource,
	StreamSlots,
	boundedPreview,
	streamDeltaFromAssistantEvent,
	toolUpdateFromExecution,
	wireStatus,
} from "./event-source.ts";
import {
	PROTOCOL_VERSION,
	type RemoteEventPayloadMap,
	type RemoteEventType,
	type SnapshotPayload,
	type WireQueueItem,
	toWireMessage,
} from "./protocol.ts";
import { startConsoleServer, type ConsoleServerHandle } from "./server.ts";
import { openConsoleOriginStore, type ConsoleOriginStore } from "./store.ts";

export interface RemoteConsoleConfig {
	/** True when HUMMIN_REMOTE=off: the endpoint must not start at all. */
	disabled: boolean;
	/** Bind address after enforcement (non-loopback requires double opt-in). */
	host: string;
	port: number;
	/** True when the server really binds beyond loopback. */
	lan: boolean;
	hostLabel: string;
	approvalTools: readonly string[];
	approvalTimeoutMs: number;
}

export interface RemoteConsoleOptions {
	sendPrompt: (text: string, deliverAs: "steer" | "followUp") => void;
	abort: () => void;
	/** Context captured at start time (the command's ctx); refreshed by event
	 * handlers as the session runs. */
	context?: ExtensionContext | undefined;
	/** Overrides; production callers take the resolved defaults. */
	port?: number;
	host?: string;
	hostLabel?: string;
	originsPath?: string;
	distDirs?: readonly string[];
	approvalTools?: readonly string[];
	approvalTimeoutMs?: number;
}

export interface RemoteConsoleHandle {
	/** Console URL with the access token in the fragment; the token is never
	 * logged and never appears in any response. */
	url: string;
	port: number;
	close: () => Promise<void>;
	/** Record a console-sent message that queued because the agent was busy.
	 * Published as a queue event; cleared when the run settles. */
	trackQueued: (text: string, deliverAs: "steer" | "followUp") => void;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const APPROVAL_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
/** Transcript tail bound for snapshots; the console virtualizes, this only
 * bounds the snapshot frame. */
const SNAPSHOT_MAX_ENTRIES = 200;
const MAX_TRACKED_QUEUE_ITEMS = 50;
const QUEUE_PREVIEW_MAX_CHARS = 200;
/** How far back a message_end looks for its session entry id. */
const ENTRY_LOOKUP_WINDOW = 8;

/** Copy of the effective settings; a guarded runtime must not break the
 * endpoint over settings reads. */
export function effectiveSettings(pi: ExtensionAPI): unknown {
	try {
		return pi.getSettings();
	} catch {
		return {};
	}
}

/** Resolve the config surface. The settings object arrives as JSON from disk
 * (trust boundary), so remoteControl.* is read defensively. Binding beyond
 * loopback requires BOTH remoteControl.allowLan: true and
 * HUMMIN_REMOTE_LAN != off; otherwise the host falls back to 127.0.0.1. */
export function resolveRemoteConsoleConfig(
	settings: unknown,
	env: NodeJS.ProcessEnv,
	machine: string = hostname(),
): RemoteConsoleConfig {
	const disabled = (env.HUMMIN_REMOTE ?? "").trim().toLowerCase() === "off";
	const rawHost = (env.HUMMIN_REMOTE_HOST ?? "").trim() || "127.0.0.1";
	const lanAllowed =
		remoteControlValue(settings, "allowLan") === true && (env.HUMMIN_REMOTE_LAN ?? "").trim().toLowerCase() !== "off";
	const host = LOOPBACK_HOSTS.has(rawHost) || lanAllowed ? rawHost : "127.0.0.1";
	const lan = !LOOPBACK_HOSTS.has(rawHost) && lanAllowed;
	const rawTimeout = remoteControlNumber(settings, "approvalTimeoutMs");
	return {
		disabled,
		host,
		port: resolvePort(settings, env),
		lan,
		hostLabel: remoteControlString(settings, "hostLabel") ?? machine,
		approvalTools: parseApprovalTools(remoteControlString(settings, "approvalTools")),
		approvalTimeoutMs:
			rawTimeout !== undefined && rawTimeout > 0 && rawTimeout <= APPROVAL_TIMEOUT_MAX_MS
				? rawTimeout
				: DEFAULT_APPROVAL_TIMEOUT_MS,
	};
}

function remoteControlValue(settings: unknown, key: string): unknown {
	if (typeof settings !== "object" || settings === null) return undefined;
	const remoteControl = (settings as { remoteControl?: unknown }).remoteControl;
	if (typeof remoteControl !== "object" || remoteControl === null) return undefined;
	return (remoteControl as Record<string, unknown>)[key];
}

function remoteControlString(settings: unknown, key: string): string | undefined {
	const value = remoteControlValue(settings, key);
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function remoteControlNumber(settings: unknown, key: string): number | undefined {
	const value = remoteControlValue(settings, key);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolvePort(settings: unknown, env: NodeJS.ProcessEnv): number {
	const rawEnv = (env.HUMMIN_REMOTE_PORT ?? "").trim();
	if (rawEnv !== "") {
		const parsed = Number.parseInt(rawEnv, 10);
		if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535) return parsed;
	}
	const setting = remoteControlNumber(settings, "port");
	if (setting !== undefined && Number.isInteger(setting) && setting >= 0 && setting <= 65_535) return setting;
	return 0;
}

function parseApprovalTools(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
}

/** Console dist candidates, first containing an index.html wins: an explicit
 * env dir, the workspace build (source runs), and the seeded agent-dir copy
 * (installed binaries). */
function defaultDistDirs(): string[] {
	const dirs: string[] = [];
	const envDist = process.env.HUMMIN_REMOTE_CONSOLE_DIST;
	if (envDist) dirs.push(envDist);
	dirs.push(join(getPackageDir(), "..", "remote-console", "dist"));
	dirs.push(join(getAgentDir(), "remote-console", "dist"));
	return dirs;
}

/** URL-safe host part of the console URL and snapshot origin, derived from
 * the resolved bind: loopback names and any-interface binds read as 127.0.0.1
 * (the one address a loopback client can always use), a LAN bind passes its
 * own host through with IPv6 literals bracketed for URL use. The scheme stays
 * http: nothing in this stack terminates TLS; a fronting proxy would end TLS
 * before these URLs are formed. */
function displayHost(host: string): string {
	if (LOOPBACK_HOSTS.has(host) || host === "0.0.0.0" || host === "::") return "127.0.0.1";
	return host.includes(":") ? `[${host}]` : host;
}

/** The session entry id of a message that just ended: identity match in the
 * branch tail, "" otherwise (including an unreadable session). The console
 * keys such blocks by slotKey instead; guessing a neighbor's id would freeze
 * the wrong slot into someone else's transcript entry. */
function endedEntryId(ctx: ExtensionContext | undefined, message: AgentMessage): string {
	try {
		if (!ctx) return "";
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0 && i >= branch.length - ENTRY_LOOKUP_WINDOW; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message === message) return entry.id;
		}
	} catch {
		// Unreadable session: the console keys the block by slotKey instead.
	}
	return "";
}

function sessionId(ctx: ExtensionContext | undefined): string {
	try {
		return ctx?.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}

/** Wire the console onto the live session and start the endpoint. */
export async function startRemoteConsole(pi: ExtensionAPI, options: RemoteConsoleOptions): Promise<RemoteConsoleHandle> {
	const config = resolveRemoteConsoleConfig(effectiveSettings(pi), process.env);
	const host = options.host ?? config.host;
	const hostLabel = options.hostLabel ?? config.hostLabel;
	const approvalTools = options.approvalTools ?? config.approvalTools;
	const approvalTimeoutMs = options.approvalTimeoutMs ?? config.approvalTimeoutMs;
	const token = randomBytes(32).toString("hex");

	const unsubscribe: (() => void)[] = [];
	let closed = false;
	let context = options.context;
	let waiting: string | undefined;
	let trackedQueue: WireQueueItem[] = [];
	let boundPort = 0;
	let approvals: ApprovalRegistry | undefined;

	function publish<K extends RemoteEventType>(type: K, payload: RemoteEventPayloadMap[K]): void {
		try {
			source.publish(type, payload);
		} catch {
			// Fire-and-forget: publish failures are swallowed (spec section 3.2).
		}
	}

	// 1 means "one or more": hasPendingMessages() is the only observable; the
	// console states that limit honestly.
	function queueState() {
		let terminalQueued = 0;
		try {
			terminalQueued = context?.hasPendingMessages() ? 1 : 0;
		} catch {
			terminalQueued = 0;
		}
		return { items: trackedQueue, terminalQueued };
	}

	function snapshot(): SnapshotPayload {
		try {
			const messages = [];
			if (context) {
				for (const entry of context.sessionManager.getBranch().slice(-SNAPSHOT_MAX_ENTRIES)) {
					if (entry.type === "message") {
						messages.push({ entryId: entry.id, timestamp: entry.timestamp, message: toWireMessage(entry.message) });
					}
				}
			}
			return {
				host: { origin: `http://${displayHost(host)}:${boundPort}`, label: hostLabel },
				protocolVersion: PROTOCOL_VERSION,
				sessionId: sessionId(context),
				sessionName: sessionName(pi),
				status: wireStatus(context, waiting),
				messages,
				holds: approvals?.pendingAll() ?? [],
				queue: queueState(),
			};
		} catch {
			// Fail-open snapshot: an unreadable session still serves a valid frame.
			return {
				host: { origin: `http://${displayHost(host)}:${boundPort}`, label: hostLabel },
				protocolVersion: PROTOCOL_VERSION,
				sessionId: "",
				sessionName: "Session",
				status: { kind: "idle", model: null },
				messages: [],
				holds: [],
				queue: { items: [], terminalQueued: 0 },
			};
		}
	}

	const source = new ConsoleEventSource(snapshot);

	approvals = new ApprovalRegistry({
		publisher: {
			pending: (holds) => publish("approval", { holds }),
			approvalDone: (id, resolution) => publish("approval_done", { id, resolution }),
		},
		tools: () => approvalTools,
		clientCount: () => source.connectionCount(),
		timeoutMs: () => approvalTimeoutMs,
	});

	const publishStatus = () => publish("status", { status: wireStatus(context, waiting) });
	const publishQueue = () => publish("queue", { queue: queueState() });

	const trackQueued = (text: string, deliverAs: "steer" | "followUp"): void => {
		try {
			trackedQueue = [
				...trackedQueue.slice(-(MAX_TRACKED_QUEUE_ITEMS - 1)),
				{
					id: randomUUID(),
					preview: text.length > QUEUE_PREVIEW_MAX_CHARS ? `${text.slice(0, QUEUE_PREVIEW_MAX_CHARS)}...` : text,
					deliverAs,
				},
			];
			publishQueue();
		} catch {
			// Queue bookkeeping never breaks a send.
		}
	};

	// Event mapping (spec section 3.2). message_start opens a streaming slot
	// per message; updates and the end carry that slot.
	const slots = new StreamSlots();
	let currentSlot = "live-0";

	unsubscribe.push(
		pi.on("message_start", (event) => {
			currentSlot = slots.next();
			publish("message_start", { slotKey: currentSlot, message: toWireMessage(event.message) });
		}),
	);
	unsubscribe.push(
		pi.on("message_update", (event, ctx) => {
			context = ctx;
			const delta = streamDeltaFromAssistantEvent(event.assistantMessageEvent);
			if (delta === undefined) return;
			publish("message_delta", { slotKey: currentSlot, event: delta });
		}),
	);
	unsubscribe.push(
		pi.on("message_end", (event, ctx) => {
			context = ctx;
			publish("message_end", {
				slotKey: currentSlot,
				entryId: endedEntryId(ctx, event.message),
				message: toWireMessage(event.message),
			});
		}),
	);
	unsubscribe.push(
		pi.on("tool_execution_start", (event) => {
			publish(
				"tool_update",
				toolUpdateFromExecution({ phase: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }),
			);
		}),
	);
	unsubscribe.push(
		pi.on("tool_execution_update", (event) => {
			publish(
				"tool_update",
				toolUpdateFromExecution({
					phase: "update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					partialResult: boundedPreview(event.partialResult),
				}),
			);
		}),
	);
	unsubscribe.push(
		pi.on("tool_execution_end", (event) => {
			publish(
				"tool_update",
				toolUpdateFromExecution({
					phase: "end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					durationMs: event.durationMs,
				}),
			);
		}),
	);
	unsubscribe.push(
		pi.on("ui_prompt_start", (event) => {
			waiting = event.title ?? event.kind;
			publishStatus();
		}),
	);
	unsubscribe.push(
		pi.on("ui_prompt_end", () => {
			waiting = undefined;
			publishStatus();
		}),
	);
	unsubscribe.push(
		pi.on("model_select", (_event, ctx) => {
			context = ctx;
			publishStatus();
		}),
	);
	unsubscribe.push(
		pi.on("thinking_level_select", () => {
			publishStatus();
		}),
	);
	unsubscribe.push(
		pi.on("agent_settled", (_event, ctx) => {
			context = ctx;
			publishStatus();
			trackedQueue = [];
			publishQueue();
		}),
	);
	unsubscribe.push(
		pi.on("session_info_changed", (event, ctx) => {
			publish("session", { sessionId: sessionId(ctx), sessionName: event.name ?? "Session" });
		}),
	);
	// Handler order vs the bashguard/sys1 tool_call gates is discovery order
	// and cannot be controlled; a gate-blocked call may also be held. Bounded
	// (holds time out) and rare.
	unsubscribe.push(pi.on("tool_call", async (event) => approvals?.hold(event.toolName, event.input)));

	const server: ConsoleServerHandle = await startConsoleServer({
		token,
		host,
		port: options.port ?? config.port,
		source,
		approvals,
		origins: openConsoleOriginStore(options.originsPath ?? join(getAgentDir(), "remote-console", "console-origins.json")),
		distDirs: options.distDirs ?? defaultDistDirs(),
		actions: { sendPrompt: options.sendPrompt, abort: options.abort },
	});
	boundPort = server.port;

	// Seed the log (seq 0) so every connection's snapshot anchors at a real
	// log head and reconnect cursors replay exactly the post-snapshot events.
	if (!closed) publishStatus();

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		for (const off of unsubscribe) {
			try {
				off();
			} catch {
				// Handler removal cannot block shutdown.
			}
		}
		approvals?.close();
		await server.close();
		source.close();
	};

	return {
		url: `http://${displayHost(host)}:${server.port}/#${token}`,
		port: server.port,
		close,
		trackQueued,
	};
}

function sessionName(pi: ExtensionAPI): string {
	try {
		return pi.getSessionName() ?? "Session";
	} catch {
		return "Session";
	}
}
