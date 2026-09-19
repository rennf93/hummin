/** Inter-agent message broker: Unix domain socket server + client + offline
 * inbox store. Pure Node, no extension API, unit testable. One broker per
 * agent dir; the first session to bind serves all later sessions. Protocol
 * is newline-delimited JSON. Incoming messages are data, not instructions:
 * transport only, never executed. */
import { connect as netConnect, createServer, type Server as NetServer, type Socket } from "node:net";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

export interface SessionInfo {
	name: string;
	project: string;
	state: "online";
	connectedAt: number;
}

export interface HelloInfo {
	sessionId: string;
	name: string;
	project: string;
	pid: number;
}

export interface DeliverFrame {
	type: "deliver";
	id: string;
	from: string;
	project: string;
	text: string;
	ts: number;
}

export type AckStatus = "delivered" | "queued" | "unknown" | "rate_limited";

export interface AckFrame {
	type: "ack";
	id: string;
	status: AckStatus;
	detail?: string;
	targets?: number;
}

export interface WelcomeFrame {
	type: "welcome";
	id: string;
	sessions: SessionInfo[];
	undelivered: number;
}

export interface SessionsFrame {
	type: "sessions";
	id: string;
	sessions: SessionInfo[];
}

export type ServerFrame = DeliverFrame | AckFrame | WelcomeFrame | SessionsFrame | { type: "error"; id: string; message: string };

export type ClientFrame =
	| { type: "hello"; id: string; info: HelloInfo }
	| { type: "send"; id: string; to: string; from: string; project: string; text: string; ts: number }
	| { type: "list"; id: string };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_TEXT = 8000;
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;
export const INBOX_MAX_ENTRIES = 100;
export const INBOX_MAX_BYTES = 1024 * 1024;
export const REPLAY_MAX = 20;
export const BROADCAST_CAP = 8;
export const KNOWN_NAMES_CAP = 500;

export function brokerSocketPath(dir: string): string {
	return join(dir, "broker.sock");
}

export function inboxPath(dir: string, name: string): string {
	return join(dir, "inbox", `${sanitizeName(name)}.jsonl`);
}

/** Safe single path component: keeps [A-Za-z0-9._-], everything else becomes "_". */
export function sanitizeName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned.slice(0, 64) || "unnamed";
}

// ---------------------------------------------------------------------------
// Offline inbox (JSONL, capped)
// ---------------------------------------------------------------------------

export interface InboxMessage {
	from: string;
	project: string;
	text: string;
	ts: number;
}

function inboxDir(dir: string): string {
	const path = join(dir, "inbox");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

export function readInbox(dir: string, name: string): InboxMessage[] {
	const file = inboxPath(dir, name);
	if (!existsSync(file)) return [];
	const messages: InboxMessage[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as InboxMessage;
			if (typeof parsed.from === "string" && typeof parsed.text === "string") messages.push(parsed);
		} catch {
			// Skip corrupt lines.
		}
	}
	return messages;
}

export function writeInbox(dir: string, name: string, messages: InboxMessage[]): void {
	const file = inboxPath(dir, name);
	inboxDir(dir);
	const data = messages.map((message) => JSON.stringify(message)).join("\n");
	const temp = `${file}.${process.pid}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, data ? `${data}\n` : "");
	} finally {
		closeSync(fd);
	}
	renameSync(temp, file);
}

/** Append with caps: at most INBOX_MAX_ENTRIES / INBOX_MAX_BYTES per target;
 * oldest entries are dropped first. Returns false when the message itself
 * was too large to keep. */
export function appendInbox(dir: string, name: string, message: InboxMessage): boolean {
	const messages = readInbox(dir, name);
	const serialized = (list: InboxMessage[]): number =>
		list.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
	messages.push(message);
	while (messages.length > 1 && (messages.length > INBOX_MAX_ENTRIES || serialized(messages) > INBOX_MAX_BYTES)) {
		messages.shift();
	}
	if (messages.length === 1 && serialized(messages) > INBOX_MAX_BYTES) return false;
	writeInbox(dir, name, messages);
	return true;
}

/** Drain FIFO: remove and return at most `max` oldest entries; the rest stay queued. */
export function drainInbox(dir: string, name: string, max = REPLAY_MAX): InboxMessage[] {
	const messages = readInbox(dir, name);
	if (messages.length === 0) return [];
	const taken = messages.splice(0, Math.max(0, max));
	writeInbox(dir, name, messages);
	return taken;
}

export function clearInbox(dir: string, name: string): void {
	writeInbox(dir, name, []);
}

// ---------------------------------------------------------------------------
// Known agent names (so "offline but known" queueing works across restarts)
// ---------------------------------------------------------------------------

function knownPath(dir: string): string {
	return join(dir, "known.json");
}

export function readKnownNames(dir: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(knownPath(dir), "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string").slice(-KNOWN_NAMES_CAP);
	} catch {
		return [];
	}
}

export function addKnownName(dir: string, name: string): void {
	const names = readKnownNames(dir).filter((entry) => entry !== name);
	names.push(name);
	while (names.length > KNOWN_NAMES_CAP) names.shift();
	const temp = `${knownPath(dir)}.${process.pid}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, JSON.stringify(names));
	} finally {
		closeSync(fd);
	}
	renameSync(temp, knownPath(dir));
}

// ---------------------------------------------------------------------------
// Broker server
// ---------------------------------------------------------------------------

interface ConnState {
	info: HelloInfo;
	connectedAt: number;
	buffer: string;
	deliveryTimes: number[];
}

/** Probe whether a socket file has a live listener. */
export function probeSocket(path: string, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = netConnect({ path });
		const settle = (alive: boolean) => {
			socket.destroy();
			resolve(alive);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => settle(true));
		socket.once("timeout", () => settle(false));
		socket.once("error", () => settle(false));
	});
}

function frameDelimited(socket: Socket, onFrame: (frame: ClientFrame) => void): (chunk: string) => void {
	let buffer = "";
	return (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				buffer = buffer.slice(-64_000);
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				onFrame(JSON.parse(line) as ClientFrame);
			} catch {
				// Malformed frame: ignore.
			}
		}
	};
}

export class BrokerServer {
	private readonly sockets = new Set<Socket>();
	private readonly conns = new Map<Socket, ConnState>();
	private readonly byName = new Map<string, Socket>();
	private listener: NetServer | undefined;
	private closed = false;
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	get path(): string {
		return brokerSocketPath(this.dir);
	}

	/** Bind the socket. Returns "bound", or "in-use" when another live broker
	 * already holds the socket file. Stale socket files are removed and rebound. */
	async start(): Promise<"bound" | "in-use"> {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		if (existsSync(this.path)) {
			if (await probeSocket(this.path)) return "in-use";
			unlinkSync(this.path);
		}
		const listener = createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(this.path, () => resolve());
		});
		chmodSync(this.path, 0o600);
		listener.on("error", () => {
			// Late errors (e.g. socket removed): keep serving existing connections.
		});
		this.listener = listener;
		return "bound";
	}

	private accept(socket: Socket): void {
		if (this.closed) {
			socket.destroy();
			return;
		}
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		const state: ConnState = {
			info: { sessionId: "", name: "", project: "", pid: 0 },
			connectedAt: 0,
			buffer: "",
			deliveryTimes: [],
		};
		const handleLine = frameDelimited(socket, (frame) => {
			if (frame.type === "hello") {
				this.handleHello(socket, frame, state);
				return;
			}
			if (!state.connectedAt) return; // Frames before hello are ignored.
			if (frame.type === "send") this.handleSend(socket, frame, state);
			if (frame.type === "list") {
				this.write(socket, { type: "sessions", id: frame.id, sessions: this.listSessions() });
			}
		});
		socket.on("data", handleLine);
		socket.on("close", () => {
			this.sockets.delete(socket);
			if (state.connectedAt && this.byName.get(state.info.name) === socket) this.byName.delete(state.info.name);
			this.conns.delete(socket);
		});
		socket.on("error", () => socket.destroy());
	}

	private write(socket: Socket, frame: ServerFrame): void {
		if (socket.destroyed) return;
		socket.write(`${JSON.stringify(frame)}\n`);
	}

	private handleHello(socket: Socket, frame: { id: string; info: HelloInfo }, state: ConnState): void {
		const raw = frame.info;
		const info: HelloInfo = {
			sessionId: String(raw.sessionId),
			name: sanitizeName(String(raw.name)),
			project: String(raw.project),
			pid: Number(raw.pid),
		};
		const existing = this.byName.get(info.name);
		if (existing && !existing.destroyed) {
			this.write(socket, { type: "error", id: frame.id, message: `Name "${info.name}" is already registered` });
			socket.destroy();
			return;
		}
		state.info = info;
		state.connectedAt = Date.now();
		this.conns.set(socket, state);
		this.byName.set(info.name, socket);
		addKnownName(this.dir, info.name);
		const undelivered = readInbox(this.dir, info.name).length;
		this.write(socket, { type: "welcome", id: frame.id, sessions: this.listSessions(), undelivered });
		for (const message of drainInbox(this.dir, info.name)) {
			this.write(socket, {
				type: "deliver",
				id: randomUUID(),
				from: message.from,
				project: message.project,
				text: message.text,
				ts: message.ts,
			});
		}
	}

	private allowDelivery(state: ConnState): boolean {
		const now = Date.now();
		state.deliveryTimes = state.deliveryTimes.filter((ts) => now - ts < RATE_WINDOW_MS);
		if (state.deliveryTimes.length >= RATE_LIMIT) return false;
		state.deliveryTimes.push(now);
		return true;
	}

	private handleSend(socket: Socket, frame: Extract<ClientFrame, { type: "send" }>, sender: ConnState): void {
		const text = frame.text.slice(0, MAX_TEXT);
		const deliver = (target: Socket): boolean => {
			const state = this.conns.get(target);
			if (!state) return false;
			if (!this.allowDelivery(state)) return false;
			this.write(target, { type: "deliver", id: frame.id, from: sender.info.name, project: frame.project, text, ts: frame.ts });
			return true;
		};
		if (frame.to.startsWith("@project:")) {
			const dirName = frame.to.slice("@project:".length);
			const targets = [...this.conns.values()]
				.filter((state) => state !== sender && basename(state.info.project) === dirName)
				.slice(0, BROADCAST_CAP)
				.map((state) => this.byName.get(state.info.name))
				.filter((target): target is Socket => Boolean(target));
			let delivered = 0;
			for (const target of targets) if (deliver(target)) delivered++;
			this.write(socket, {
				type: "ack",
				id: frame.id,
				status: delivered > 0 ? "delivered" : "unknown",
				targets: delivered,
				detail: delivered > 0 ? `broadcast to ${delivered} session(s)` : `no online sessions for project "${dirName}"`,
			});
			return;
		}
		const to = sanitizeName(frame.to);
		const target = this.byName.get(to);
		if (target && !target.destroyed) {
			if (deliver(target)) {
				this.write(socket, { type: "ack", id: frame.id, status: "delivered", detail: to });
			} else {
				this.write(socket, { type: "ack", id: frame.id, status: "rate_limited", detail: to });
			}
			return;
		}
		if (readKnownNames(this.dir).includes(to)) {
			const queued = appendInbox(this.dir, to, { from: sender.info.name, project: frame.project, text, ts: frame.ts });
			this.write(socket, {
				type: "ack",
				id: frame.id,
				status: queued ? "queued" : "unknown",
				detail: queued ? to : `message too large for ${to}'s inbox`,
			});
			return;
		}
		this.write(socket, { type: "ack", id: frame.id, status: "unknown", detail: to });
	}

	listSessions(): SessionInfo[] {
		return [...this.conns.values()].map((state) => ({
			name: state.info.name,
			project: state.info.project,
			state: "online" as const,
			connectedAt: state.connectedAt,
		}));
	}

	async close(unlinkSocket = true): Promise<void> {
		this.closed = true;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.conns.clear();
		this.byName.clear();
		const listener = this.listener;
		this.listener = undefined;
		if (!listener) return;
		await new Promise<void>((resolve) => listener.close(() => resolve()));
		if (unlinkSocket && existsSync(this.path)) unlinkSync(this.path);
	}
}

// ---------------------------------------------------------------------------
// Broker client
// ---------------------------------------------------------------------------

interface Pending {
	resolve: (frame: ServerFrame) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class BrokerClient {
	/** Deliver callback. Buffered frames flush when this is first assigned. */
	private deliverHandler: ((frame: DeliverFrame) => void) | undefined;
	private buffered: DeliverFrame[] = [];
	set onDeliver(handler: ((frame: DeliverFrame) => void) | undefined) {
		this.deliverHandler = handler;
		const bufferedFrames = this.buffered;
		this.buffered = [];
		if (handler) for (const frame of bufferedFrames) handler(frame);
	}
	get onDeliver(): ((frame: DeliverFrame) => void) | undefined {
		return this.deliverHandler;
	}
	private welcomed = false;
	private onWelcome: (() => void) | undefined;
	/** Invoked once when the socket closes (broker holder died or shut down). */
	onClose: (() => void) | undefined;
	private readonly pending = new Map<string, Pending>();
	private closed = false;
	private readonly socket: Socket;
	readonly info: HelloInfo & { connectedAt: number };

	private constructor(info: HelloInfo & { connectedAt: number }, socket: Socket) {
		this.info = info;
		this.socket = socket;
		socket.setEncoding("utf8");
		// A single handler owns the socket for the client's lifetime, so replay
		// frames that share a data chunk with the welcome are never dropped;
		// they buffer until onDeliver is assigned.
		const handle = frameDelimited(socket, (frame) => {
			const parsed = frame as unknown as ServerFrame;
			if (parsed.type === "deliver") {
				if (this.onDeliver) this.onDeliver(parsed);
				else this.buffered.push(parsed);
				return;
			}
			if (parsed.type === "welcome" && !this.welcomed) {
				this.welcomed = true;
				this.onWelcome?.();
				return;
			}
			if (parsed.type === "welcome" || parsed.type === "ack" || parsed.type === "sessions" || parsed.type === "error") {
				const pending = this.pending.get(parsed.id);
				if (!pending) return;
				this.pending.delete(parsed.id);
				clearTimeout(pending.timer);
				if (parsed.type === "error") pending.reject(new Error(parsed.message));
				else pending.resolve(parsed);
			}
		});
		socket.on("data", handle);
		socket.on("close", () => {
			this.closed = true;
			this.onClose?.();
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(new Error("Broker connection closed"));
				this.pending.delete(id);
			}
		});
		socket.on("error", () => socket.destroy());
	}

	get connected(): boolean {
		return !this.closed;
	}

	/** Connect and perform the hello handshake. */
	static connect(dir: string, info: HelloInfo, timeoutMs = 3000): Promise<BrokerClient> {
		return new Promise((resolve, reject) => {
			const socket = netConnect({ path: brokerSocketPath(dir) });
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error("Broker connect timed out")), timeoutMs);
			socket.once("error", (error) => fail(new Error(`Cannot reach broker: ${error.message}`)));
			const client = new BrokerClient({ ...info, connectedAt: Date.now() }, socket);
			socket.once("close", () => fail(new Error("Broker closed before welcome")));
			client.onWelcome = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(client);
			};
			socket.once("connect", () => {
				socket.write(`${JSON.stringify({ type: "hello", id: randomUUID(), info } satisfies ClientFrame)}\n`);
			});
		});
	}

	private request(frame: ClientFrame, timeoutMs = 5000): Promise<ServerFrame> {
		if (this.closed) return Promise.reject(new Error("Broker connection closed"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(frame.id);
				reject(new Error("Broker request timed out"));
			}, timeoutMs);
			this.pending.set(frame.id, { resolve, reject, timer });
			this.socket.write(`${JSON.stringify(frame)}\n`);
		});
	}

	async send(to: string, text: string): Promise<AckFrame> {
		if (text.length > MAX_TEXT) throw new Error(`Message text exceeds ${MAX_TEXT} characters`);
		const frame = await this.request({
			type: "send",
			id: randomUUID(),
			to,
			from: this.info.name,
			project: this.info.project,
			text,
			ts: Date.now(),
		});
		return frame as AckFrame;
	}

	async listSessions(): Promise<SessionInfo[]> {
		const frame = await this.request({ type: "list", id: randomUUID() });
		return (frame as SessionsFrame).sessions;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
	}
}
