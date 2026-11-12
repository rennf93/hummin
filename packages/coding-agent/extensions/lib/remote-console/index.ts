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
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { ApprovalRegistry } from "./approvals.ts";
import { customEntryToWire, customToWireMessage, isCustomAgentMessage } from "./custom-messages.ts";
import {
	ConsoleEventSource,
	type StatusExtras,
	StreamSlots,
	boundedPreview,
	streamDeltaFromAssistantEvent,
	toolUpdateFromExecution,
	wireStatus,
} from "./event-source.ts";
import { readFleetServers } from "./fleet.ts";
import {
	type ActivityPayload,
	PROTOCOL_VERSION,
	type RemoteEventPayloadMap,
	type RemoteEventType,
	type SnapshotPayload,
	type WireActivity,
	type WireAgentMessage,
	type WireFleetServer,
	type WireQueueItem,
	type WireStats,
	type WireTranscriptEntry,
	type WireWorkspace,
	toWireMessage,
} from "./protocol.ts";
import { startConsoleServer, type ConsoleServerHandle } from "./server.ts";
import { SessionStatsCache, TokenRateTracker } from "./stats.ts";
import { openConsoleOriginStore, type ConsoleOriginStore } from "./store.ts";
import { readWorkspace } from "./workspace.ts";

interface ToolUpdateThrottle {
	toolName: string;
	lastAt: number;
	timer: NodeJS.Timeout | undefined;
	latest: string | undefined;
}

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
/** Minimum gap between status publishes triggered by streaming updates. */
const STREAM_STATUS_INTERVAL_MS = 1000;
const FLEET_POLL_MS = 30_000;
/** Longest activity detail on the wire (error messages arrive raw). */
const ACTIVITY_DETAIL_MAX_CHARS = 200;
/** Minimum gap between published partial results of one running tool call. */
const TOOL_UPDATE_INTERVAL_MS = 250;

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
 * env dir, the workspace build (source runs), the copy shipped inside the
 * package (installed binaries), and the seeded agent-dir copy. */
function defaultDistDirs(): string[] {
	const dirs: string[] = [];
	const envDist = process.env.HUMMIN_REMOTE_CONSOLE_DIST;
	if (envDist) dirs.push(envDist);
	dirs.push(join(getPackageDir(), "..", "remote-console", "dist"));
	dirs.push(join(getPackageDir(), "extensions", "lib", "remote-console", "dist"));
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
 * branch tail, undefined otherwise (including an unreadable session). Core
 * emits message_end before persisting the entry, so a live message normally
 * has no match yet; the caller then publishes a synthetic `live:<slotKey>` id
 * (guessing a neighbor's id would freeze the wrong slot into someone else's
 * transcript entry). The next snapshot carries the real ids. */
function endedEntryId(ctx: ExtensionContext | undefined, message: AgentMessage): string | undefined {
	try {
		if (!ctx) return undefined;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0 && i >= branch.length - ENTRY_LOOKUP_WINDOW; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message === message) return entry.id;
		}
	} catch {
		// Unreadable session: the caller falls back to the synthetic id.
	}
	return undefined;
}

/** Custom messages come from extensions (untrusted shape): a conversion
 * failure drops the event instead of throwing out of the handler. */
function wireMessageOf(message: AgentMessage): WireAgentMessage | undefined {
	if (!isCustomAgentMessage(message)) return toWireMessage(message);
	try {
		return customToWireMessage(message);
	} catch {
		return undefined;
	}
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
	// Totals cover every entry of the session file like the TUI footer; todos
	// follow the current branch.
	const entriesStatsCache = new SessionStatsCache();
	const branchStatsCache = new SessionStatsCache();
	const tokenRate = new TokenRateTracker();
	let streaming = false;
	let lastStreamStatusAt = 0;
	let workspace: WireWorkspace | undefined;
	let lastFleetJson = "";
	// The activity a console that attaches now should still see: in progress,
	// or the last failure until the next start or agent run.
	let currentActivity: WireActivity | undefined;
	let compactionStarted = false;
	const toolUpdates = new Map<string, ToolUpdateThrottle>();

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

	function currentStats(): WireStats | undefined {
		let fromSession: WireStats = {};
		try {
			if (context) {
				fromSession = entriesStatsCache.compute(context.sessionManager.getEntries());
				delete fromSession.todos;
				const { todos } = branchStatsCache.compute(context.sessionManager.getBranch());
				if (todos) fromSession.todos = todos;
			}
		} catch {
			fromSession = {};
		}
		if (Object.keys(fromSession).length === 0 && !streaming) return undefined;
		return { ...fromSession, tokensPerSecond: streaming ? tokenRate.rate : null };
	}

	// Mirrors SETTINGS_DEFAULTS.compaction.enabled (true), which core does not export.
	function autoCompact(): boolean | undefined {
		try {
			const enabled = (pi.getSettings() as { compaction?: { enabled?: unknown } }).compaction?.enabled;
			return typeof enabled === "boolean" ? enabled : true;
		} catch {
			return undefined;
		}
	}

	function statusExtras(): StatusExtras {
		return { stats: currentStats(), workspace, autoCompact: autoCompact(), version: VERSION };
	}

	function currentFleet(): WireFleetServer[] {
		return readFleetServers({
			settings: effectiveSettings(pi),
			activeProvider: context?.model?.provider,
		});
	}

	function snapshot(): SnapshotPayload {
		try {
			const messages: WireTranscriptEntry[] = [];
			if (context) {
				const visible = context.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "message" || entry.type === "custom_message");
				for (const entry of visible.slice(-SNAPSHOT_MAX_ENTRIES)) {
					try {
						if (entry.type === "message") {
							messages.push({ entryId: entry.id, timestamp: entry.timestamp, message: toWireMessage(entry.message) });
						} else if (entry.type === "custom_message") {
							messages.push(customEntryToWire(entry));
						}
					} catch {
						// One malformed entry must not empty the whole snapshot.
					}
				}
			}
			const fleet = currentFleet();
			return {
				host: { origin: `http://${displayHost(host)}:${boundPort}`, label: hostLabel },
				protocolVersion: PROTOCOL_VERSION,
				sessionId: sessionId(context),
				sessionName: sessionName(pi),
				status: wireStatus(context, waiting, statusExtras()),
				messages,
				holds: approvals?.pendingAll() ?? [],
				queue: queueState(),
				...(fleet.length > 0 ? { fleet } : {}),
				...(currentActivity ? { activity: currentActivity } : {}),
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

	const publishStatus = () => publish("status", { status: wireStatus(context, waiting, statusExtras()) });

	const publishActivity = (input: ActivityPayload["activity"]) => {
		const activity: WireActivity =
			input.detail === undefined ? input : { ...input, detail: input.detail.slice(0, ACTIVITY_DETAIL_MAX_CHARS) };
		if (activity.phase === "end") {
			if (currentActivity?.kind === activity.kind) currentActivity = undefined;
		} else {
			currentActivity = activity;
		}
		publish("activity", { activity });
	};

	// Fleet list changes are detected by comparing the serialized list; the
	// startup baseline is recorded without publishing (the snapshot carries it).
	const checkFleet = () => {
		const servers = currentFleet();
		const json = JSON.stringify(servers);
		if (json === lastFleetJson) return;
		lastFleetJson = json;
		publish("fleet", { servers });
	};

	// Async and off the hot path; true when repo or branch changed.
	const refreshWorkspace = async (): Promise<boolean> => {
		try {
			const cwd = context?.cwd;
			if (typeof cwd !== "string") return false;
			const next = await readWorkspace(cwd);
			if (JSON.stringify(next) === JSON.stringify(workspace)) return false;
			workspace = next;
			return true;
		} catch {
			return false;
		}
	};
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

	function publishToolPartial(toolCallId: string, toolName: string, partialResult: string): void {
		publish("tool_update", toolUpdateFromExecution({ phase: "update", toolCallId, toolName, partialResult }));
	}

	// Trailing edge: the latest partial result held back by the throttle goes out.
	function flushToolThrottle(toolCallId: string): void {
		const throttle = toolUpdates.get(toolCallId);
		if (!throttle) return;
		if (throttle.timer !== undefined) clearTimeout(throttle.timer);
		throttle.timer = undefined;
		if (throttle.latest === undefined) return;
		const latest = throttle.latest;
		throttle.latest = undefined;
		throttle.lastAt = Date.now();
		publishToolPartial(toolCallId, throttle.toolName, latest);
	}

	function dropToolThrottle(toolCallId: string): void {
		const throttle = toolUpdates.get(toolCallId);
		if (throttle?.timer !== undefined) clearTimeout(throttle.timer);
		toolUpdates.delete(toolCallId);
	}

	// Event mapping (spec section 3.2). message_start opens a streaming slot
	// per message; updates and the end carry that slot.
	const slots = new StreamSlots();
	let currentSlot = "live-0";
	let slotOpen = false;

	unsubscribe.push(
		pi.on("message_start", (event) => {
			currentSlot = slots.next();
			slotOpen = true;
			const message = wireMessageOf(event.message);
			if (message) publish("message_start", { slotKey: currentSlot, message });
			if (event.message.role === "assistant") {
				streaming = true;
				tokenRate.reset();
			}
		}),
	);
	unsubscribe.push(
		pi.on("message_update", (event, ctx) => {
			context = ctx;
			const delta = streamDeltaFromAssistantEvent(event.assistantMessageEvent);
			if (delta !== undefined) publish("message_delta", { slotKey: currentSlot, event: delta });
			const output = (event.message as { usage?: { output?: unknown } }).usage?.output;
			if (typeof output !== "number") return;
			const now = Date.now();
			streaming = true;
			tokenRate.sample(output, now);
			if (now - lastStreamStatusAt >= STREAM_STATUS_INTERVAL_MS) {
				lastStreamStatusAt = now;
				publishStatus();
			}
		}),
	);
	unsubscribe.push(
		pi.on("message_end", (event, ctx) => {
			context = ctx;
			const message = wireMessageOf(event.message);
			// A message_end with no message_start still needs its own unique slot.
			const slotKey = slotOpen ? currentSlot : slots.next();
			slotOpen = false;
			if (message) {
				publish("message_end", {
					slotKey,
					entryId: endedEntryId(ctx, event.message) ?? `live:${slotKey}`,
					message,
				});
			}
			if (event.message.role === "assistant") {
				// The status only exists to clear a stale tok/s; without a rate there is nothing to clear.
				const hadRate = tokenRate.rate !== null;
				streaming = false;
				tokenRate.reset();
				if (hadRate) publishStatus();
			}
		}),
	);
	// The assistant entry is persisted by turn end, so the totals read here
	// include it (message_end can fire before persistence).
	unsubscribe.push(
		pi.on("turn_end", (_event, ctx) => {
			context = ctx;
			streaming = false;
			tokenRate.reset();
			publishStatus();
		}),
	);
	unsubscribe.push(
		pi.on("tool_execution_start", (event) => {
			dropToolThrottle(event.toolCallId);
			publish(
				"tool_update",
				toolUpdateFromExecution({ phase: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }),
			);
		}),
	);
	unsubscribe.push(
		pi.on("tool_execution_update", (event) => {
			const partialResult = boundedPreview(event.partialResult);
			const now = Date.now();
			const throttle = toolUpdates.get(event.toolCallId);
			if (!throttle || (throttle.timer === undefined && now - throttle.lastAt >= TOOL_UPDATE_INTERVAL_MS)) {
				toolUpdates.set(event.toolCallId, { toolName: event.toolName, lastAt: now, timer: undefined, latest: undefined });
				publishToolPartial(event.toolCallId, event.toolName, partialResult);
				return;
			}
			throttle.latest = partialResult;
			if (throttle.timer !== undefined) return;
			throttle.timer = setTimeout(() => flushToolThrottle(event.toolCallId), TOOL_UPDATE_INTERVAL_MS - (now - throttle.lastAt));
			throttle.timer.unref();
		}),
	);
	unsubscribe.push(
		pi.on("tool_execution_end", (event) => {
			flushToolThrottle(event.toolCallId);
			dropToolThrottle(event.toolCallId);
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
			checkFleet();
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
			streaming = false;
			tokenRate.reset();
			publishStatus();
			trackedQueue = [];
			publishQueue();
			checkFleet();
			void refreshWorkspace().then((changed) => {
				if (changed && !closed) publishStatus();
			});
		}),
	);
	unsubscribe.push(
		pi.on("agent_start", () => {
			if (currentActivity?.phase === "failed") currentActivity = undefined;
		}),
	);
	unsubscribe.push(
		pi.on("session_before_compact", (event) => {
			compactionStarted = true;
			publishActivity({ kind: "compaction", phase: "start", detail: event.reason });
		}),
	);
	unsubscribe.push(
		pi.on("session_compact", (event) => {
			compactionStarted = false;
			publishActivity({ kind: "compaction", phase: "end", detail: event.reason });
		}),
	);
	// A failure with no start never showed activity ("nothing to compact"), and
	// an abort is not an error: it just ends what had started.
	unsubscribe.push(
		pi.on("session_compact_failed", (event) => {
			const hadStart = compactionStarted;
			compactionStarted = false;
			if (!hadStart) return;
			if (event.aborted) publishActivity({ kind: "compaction", phase: "end", detail: "aborted" });
			else publishActivity({ kind: "compaction", phase: "failed", detail: event.errorMessage ?? event.reason });
		}),
	);
	// Memory fold activity is emitted by hummin-memory on the shared bus.
	try {
		const off = pi.events?.on("hummin:memory_fold", (data) => {
			const phase = (data as { phase?: unknown } | null)?.phase;
			if (phase !== "start" && phase !== "end" && phase !== "failed") return;
			const detail = (data as { detail?: unknown }).detail;
			publishActivity({ kind: "memory_fold", phase, ...(typeof detail === "string" ? { detail } : {}) });
		});
		if (off) unsubscribe.push(off);
	} catch {
		// A bus that cannot subscribe only loses fold activity.
	}
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

	await refreshWorkspace();
	lastFleetJson = JSON.stringify(currentFleet());
	const fleetTimer = setInterval(() => {
		if (!closed && source.connectionCount() > 0) checkFleet();
	}, FLEET_POLL_MS);
	fleetTimer.unref();

	// Seed the log (seq 0) so every connection's snapshot anchors at a real
	// log head and reconnect cursors replay exactly the post-snapshot events.
	if (!closed) publishStatus();

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		clearInterval(fleetTimer);
		for (const toolCallId of [...toolUpdates.keys()]) dropToolThrottle(toolCallId);
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
