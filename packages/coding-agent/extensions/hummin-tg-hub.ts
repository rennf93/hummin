/**
 * hummin-tg-hub: bridge a hummin session to a cc-tg-hub broker (Telegram).
 *
 * https://github.com/rennf93/cc-tg-hub drives Claude Code sessions from a
 * Telegram forum group: one broker (the only Telegram poller), one topic per
 * session, permission prompts as Allow/Deny buttons. The broker is
 * host-agnostic - it speaks line-delimited JSON frames over a UNIX socket and
 * cannot tell a Claude Code MCP from this extension. This file is that client
 * for hummin sessions (a port of cc-tg-hub's mcp/src/broker-client.ts onto the
 * extension API):
 *
 *   register {sessionId, name, cwd}  -> registered {topicId, chatId}
 *   inbound  message frame           -> sendUserMessage (steer when busy,
 *                                       followUp when idle)
 *   tg_reply tool                    -> reply frame (text + optional files)
 *   tool_call on the ask-list        -> permission_ask frame; the Telegram
 *                                       Deny button blocks the call, Allow
 *                                       (or a 120s timeout) lets the normal
 *                                       hummin flow proceed - the terminal
 *                                       dialog, if one would appear, stays
 *                                       live either way.
 *   session_shutdown                 -> unregister + disconnect
 *
 * Reconnect with backoff and re-register on socket close; respawn the broker
 * when it died (pidfile guard mirrors cc-tg-hub's own duplicate-broker guard).
 *
 * Config (opt-in; default OFF so cron/distill/child sessions never register):
 *   TG_HUB=1                   enable for this session. The precise switch for
 *                              interactive use - alias it:
 *                              alias hummin-tg='TG_HUB=1 hummin'
 *                              Setting tgHub.enabled=true in settings also
 *                              enables, but settings are global: it would
 *                              register child/cron sessions too. Prefer the
 *                              env alias.
 *   TG_HUB_SOCKET              broker socket path
 *                              (default ~/.claude/cc-tg-hub/broker.sock,
 *                              same as cc-tg-hub; TG_HUB_SOCKET override is
 *                              theirs too)
 *   TG_HUB_ASK_TOOLS           comma-separated tool names to forward as
 *                              Allow/Deny prompts (default: none). Deny
 *                              blocks; Allow never bypasses a terminal
 *                              dialog (the extension API cannot answer it) -
 *                              run with --approve for fully unattended use.
 *   tgHub.enabled /            settings fallback / socketPath override
 *   tgHub.socketPath           (tgHub.enabled is global - see TG_HUB note)
 *
 * One broker per machine; Telegram enforces one getUpdates poller per bot
 * token. Driving sessions on two machines needs two bots (or one machine).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// frames (mirror of cc-tg-hub shared/src/frames.ts)

interface RegisterFrame { type: "register"; sessionId: string; name: string; cwd: string }
interface RegisteredFrame { type: "registered"; topicId: number; chatId: string }
interface ReplyFrame { type: "reply"; chatId: string; text: string; files?: string[] }
interface MessageFrame {
	type: "message";
	chatId: string;
	topicId: number;
	user: string;
	userId?: string;
	text: string;
	image_path?: string;
	attachment_name?: string;
}
interface PermissionAskFrame { type: "permission_ask"; requestId: string; toolName: string; description?: string; inputPreview?: string }
interface PermissionDecisionFrame { type: "permission_decision"; requestId: string; behavior: "allow" | "deny" }
interface UnregisterFrame { type: "unregister" }
type OutboundFrame = RegisterFrame | ReplyFrame | PermissionAskFrame | UnregisterFrame;
type InboundFrame = RegisteredFrame | MessageFrame | PermissionDecisionFrame | { type: "stop" };

function encodeFrame(f: OutboundFrame): string {
	return JSON.stringify(f) + "\n";
}

function parseFrame(line: string): InboundFrame | undefined {
	try {
		const raw = JSON.parse(line) as { type?: unknown };
		if (typeof raw.type !== "string") return undefined;
		return raw as InboundFrame;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// config

const DEFAULT_SOCKET = join(homedir(), ".claude", "cc-tg-hub", "broker.sock");
const DEFAULT_CLI = join(homedir(), ".claude", "cc-tg-hub", "cli.js");
const LOG_FILE = join(homedir(), "Library", "Logs", "hummin-tg-hub.log");
const PERMISSION_TIMEOUT_MS = 120_000;

interface TgHubConfig {
	enabled: boolean;
	socketPath: string;
	askTools: Set<string>;
	spawnBroker: boolean;
}

function resolveConfig(): TgHubConfig {
	let enabled = process.env.TG_HUB === "1";
	let socketPath = process.env.TG_HUB_SOCKET;
	let askTools = process.env.TG_HUB_ASK_TOOLS;
	try {
		const settings = SettingsManager.create(process.cwd()).getSettings().tgHub;
		if (settings) {
			if (settings.enabled === true) enabled = true;
			socketPath = socketPath ?? settings.socketPath;
			askTools = askTools ?? (settings.askTools ?? []).join(",");
		}
	} catch {
		// settings unavailable - env-only
	}
	return {
		enabled,
		socketPath: socketPath ?? DEFAULT_SOCKET,
		askTools: new Set(
			(askTools ?? "")
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
		),
		spawnBroker: process.env.TG_HUB_SPAWN !== "0",
	};
}

function log(line: string): void {
	try {
		mkdirSync(join(homedir(), "Library", "Logs"), { recursive: true });
		appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// logging is best-effort
	}
}

// ---------------------------------------------------------------------------
// socket client (port of cc-tg-hub mcp/src/broker-client.ts)

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

function probeSocket(sockPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect(sockPath, () => {
			s.end();
			resolve(true);
		});
		s.on("error", () => resolve(false));
	});
}

function waitSocket(sockPath: string, ms: number): Promise<boolean> {
	const start = Date.now();
	return (function loop(): Promise<boolean> {
		if (existsSync(sockPath)) {
			return probeSocket(sockPath).then((ok) => (ok ? true : Date.now() - start > ms ? false : loop()));
		}
		return Date.now() - start > ms ? Promise.resolve(false) : new Promise((r) => setTimeout(() => r(loop()), 100));
	})();
}

function readPid(sockDir: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(sockDir, "broker.pid"), "utf8").trim());
		if (!Number.isFinite(pid) || pid <= 0) return undefined;
		process.kill(pid, 0);
		return pid;
	} catch {
		return undefined;
	}
}

export default function humminTgHub(pi: ExtensionAPI): void {
	const config = resolveConfig();
	if (!config.enabled) return;

	let sock: Socket | undefined;
	let buf = "";
	let closed = false; // session shut down - stop reconnecting
	let registered = false;
	let chatId: string | undefined;
	let sessionId = "";
	let sessionCtx: ExtensionContext | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingPermissions = new Map<string, (behavior: "allow" | "deny" | undefined) => void>();

	function logLine(line: string): void {
		log(`[${sessionId || "session"}] ${line}`);
	}

	function send(f: OutboundFrame): void {
		sock?.write(encodeFrame(f));
	}

	function onRegistered(f: RegisteredFrame): void {
		chatId = f.chatId;
		registered = true;
		logLine(`registered topic=${f.topicId} chatId=${f.chatId}`);
	}

	function onMessage(f: MessageFrame): void {
		const parts: (TextContent | ImageContent)[] = [];
		let text = `[Telegram · ${f.user}] ${f.text}`;
		if (f.attachment_name) text += `\n(attachment: ${f.attachment_name})`;
		parts.push({ type: "text", text });
		if (f.image_path) {
			try {
				const ext = f.image_path.split(".").pop()?.toLowerCase() ?? "";
				const mime = IMAGE_MIME[ext] ?? "image/png";
				parts.push({ type: "image", mimeType: mime, data: readFileSync(f.image_path).toString("base64") });
			} catch (e) {
				parts.push({ type: "text", text: `(could not load image ${f.image_path}: ${String(e)})` });
			}
		}
		const deliverAs = sessionCtx?.isIdle() === false ? "steer" : "followUp";
		logLine(`inbound from ${f.user} (${deliverAs}): ${f.text.slice(0, 120)}`);
		void pi.sendUserMessage(parts, { deliverAs, expandPromptTemplates: false });
	}

	function onPermissionDecision(f: PermissionDecisionFrame): void {
		const resolve = pendingPermissions.get(f.requestId);
		if (resolve) {
			pendingPermissions.delete(f.requestId);
			resolve(f.behavior);
		}
	}

	function onData(b: Buffer): void {
		buf += b.toString();
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			const f = parseFrame(line);
			if (!f) continue;
			if (f.type === "registered") onRegistered(f);
			else if (f.type === "message") onMessage(f);
			else if (f.type === "permission_decision") onPermissionDecision(f);
			else if (f.type === "stop") {
				logLine("stop frame - disconnecting (session keeps running)");
				shutdown();
			}
		}
	}

	function register(): void {
		if (!sock) return;
		registered = false;
		send({ type: "register", sessionId, name: basename(sessionCtx?.cwd ?? process.cwd()), cwd: sessionCtx?.cwd ?? process.cwd() });
	}

	function connectOnce(): Promise<void> {
		return new Promise((resolve, reject) => {
			const onErr = (): void => {
				if (!closed) reject(new Error("socket error"));
			};
			buf = "";
			sock = connect(config.socketPath);
			sock.on("error", onErr);
			sock.on("close", () => {
				registered = false;
				if (closed) return;
				// broker died or socket dropped - reconnect with backoff and
				// re-register; connectBroker respawns the broker if needed
				if (reconnectTimer) clearTimeout(reconnectTimer);
				reconnectTimer = setTimeout(() => {
					if (!closed) void connectBroker().catch(() => {});
				}, 1000);
			});
			sock.on("connect", () => {
				register();
				resolve();
			});
			sock.on("data", onData);
		});
	}

	async function ensureBroker(): Promise<void> {
		if (await probeSocket(config.socketPath)) return;
		const sockDir = config.socketPath.slice(0, config.socketPath.lastIndexOf("/"));
		const pid = readPid(sockDir);
		if (pid) {
			// another session's broker is mid-bind - wait, don't duplicate
			logLine(`broker pid ${pid} alive, waiting for socket`);
			await waitSocket(config.socketPath, 8000);
			return;
		}
		if (!config.spawnBroker || !existsSync(DEFAULT_CLI)) {
			logLine(`no broker on ${config.socketPath}${config.spawnBroker ? "" : " (TG_HUB_SPAWN=0)"}`);
			return;
		}
		try {
			unlinkSync(config.socketPath);
		} catch {
			// nothing to clean
		}
		logLine("spawning detached broker");
		spawn("/bin/zsh", ["-c", `bun "${DEFAULT_CLI}" broker >/dev/null 2>&1 &`], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, CC_TG_HUB_DAEMON: "1" },
		}).unref();
		await waitSocket(config.socketPath, 8000);
	}

	// Named connectBroker (not connect): a local `connect` would shadow the
	// node:net import inside this closure and recurse into itself.
	async function connectBroker(): Promise<void> {
		try {
			await connectOnce();
		} catch {
			if (closed) return;
			await ensureBroker();
			try {
				await connectOnce();
			} catch (e) {
				logLine(`broker unreachable: ${String(e)}`);
			}
		}
	}

	function shutdown(): void {
		if (closed && !sock) return;
		closed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		try {
			send({ type: "unregister" });
		} catch {
			// socket already gone
		}
		sock?.end();
		sock = undefined;
		for (const resolve of pendingPermissions.values()) resolve(undefined);
		pendingPermissions.clear();
	}

	// -------------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		if (!closed) {
			// a bridge bug must never take the session down
			void connectBroker().catch((e) => logLine(`connect failed: ${String(e)}`));
		}
	});

	pi.on("session_shutdown", () => {
		shutdown();
	});

	pi.on("tool_call", (event) => {
		if (!registered || !config.askTools.has(event.toolName)) return;
		const requestId = randomUUID();
		const inputPreview = JSON.stringify(event.input ?? {}).slice(0, 300);
		logLine(`permission_ask ${event.toolName} (${requestId})`);
		send({ type: "permission_ask", requestId, toolName: event.toolName, description: event.toolName, inputPreview });
		return new Promise<{ block: boolean; reason: string } | undefined>((resolve) => {
			const timer = setTimeout(() => {
				pendingPermissions.delete(requestId);
				resolve(undefined); // timeout: normal hummin flow proceeds
			}, PERMISSION_TIMEOUT_MS);
			pendingPermissions.set(requestId, (behavior) => {
				clearTimeout(timer);
				if (behavior === "deny") {
					logLine(`denied from Telegram: ${event.toolName}`);
					resolve({ block: true, reason: "Denied from Telegram (cc-tg-hub Allow/Deny buttons)." });
				} else {
					logLine(`allowed from Telegram: ${event.toolName}`);
					resolve(undefined); // terminal flow proceeds as usual
				}
			});
		});
	});

	pi.registerTool({
		name: "tg_reply",
		label: "Telegram Reply",
		description:
			"Send a message to the Telegram topic bound to this session (cc-tg-hub). Use it to answer the user when the conversation is happening over Telegram; the user sees it on their phone. Optional files are sent as photos/documents after the text.",
		promptSnippet: "tg_reply: send a message to this session's Telegram topic",
		parameters: Type.Object({
			text: Type.String({ minLength: 1, maxLength: 4000, description: "Message text to send" }),
			files: Type.Optional(
				Type.Array(Type.String(), { description: "Absolute file paths to attach (sent as photos/documents)" }),
			),
		}),
		async execute(_id, params) {
			if (!registered || !chatId) {
				return {
					content: [{ type: "text", text: "Not registered with a cc-tg-hub broker (no Telegram topic bound)." }],
					isError: true,
				};
			}
			send({ type: "reply", chatId, text: params.text, files: params.files });
			logLine(`reply sent (${params.text.length} chars, ${params.files?.length ?? 0} files)`);
			return { content: [{ type: "text", text: "Sent to the Telegram topic." }] };
		},
	});
}
