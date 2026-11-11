/**
 * demo: dev-only fixture playback so every console state is viewable without a
 * live host. `?demo=<fixture>` (a name from harness/fixtures, served by the
 * vite dev server) loads that snapshot into a fake host, then plays a scripted
 * live turn: thinking, streamed markdown, a tool call with an approval hold,
 * partial and final tool output, a queued follow-up, a compaction between the
 * two answers. Status events carry fake session stats (tok/s moves while text
 * streams), and the snapshot carries a two-server fake fleet. Sending a prompt in the
 * composer replays the turn; approve and deny resolve the hold. Two extra rail
 * hosts carry the reconnecting and unauthorized states. `?demo=empty` skips
 * the fixture. Callers gate on import.meta.env.DEV so production builds drop
 * this module entirely.
 */
/// <reference lib="dom" />
import type { ConnectionState } from "./connection.ts";
import type {
	AnyRemoteEvent,
	RemoteEventPayloadMap,
	RemoteEventType,
	WireAgentMessage,
	WireFleetServer,
	WireStats,
	WireStatus,
} from "./harness/replay-log.ts";
import type { HostEntry } from "./hosts.ts";

export const DEMO_ORIGIN = "demo://local";

export const DEMO_HOSTS: readonly HostEntry[] = [
	{ id: "demo", label: "studio-mac", origin: DEMO_ORIGIN, token: "demo" },
	{ id: "demo-reconnecting", label: "nas-llama", origin: "demo://reconnecting", token: "demo" },
	{ id: "demo-unauthorized", label: "tailnet-box", origin: "demo://unauthorized", token: "demo" },
];

/** The fixture name of a `?demo=` query, or null when the page is not a demo.
 * Names are restricted to file-name characters: the value becomes a fetch path. */
export function demoFixtureName(search: string): string | null {
	const name = new URLSearchParams(search).get("demo");
	return name !== null && /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

export interface DemoSession {
	prompt(text: string, deliverAs: "steer" | "followUp"): void;
	resolveApproval(id: string, allow: boolean): void;
	abort(): void;
	close(): void;
}

const MODEL = { provider: "llamacpp", modelId: "qwen3-coder-30b" };

const WORKSPACE = { cwd: "/home/demo/projects/console", repo: "console", branch: "main" };

/** Obviously fake output speeds that cycle while text streams. */
const TOKENS_PER_SECOND = [96, 112, 138, 124, 91, 131, 118];

const FLEET: WireFleetServer[] = [
	{
		id: "llamacpp-fleet-a.test-8080",
		engine: "llamacpp",
		host: "fleet-a.test",
		port: 8080,
		discovery: "fresh",
		models: ["demo-coder-30b"],
		active: true,
	},
	{
		id: "colibri-fleet-b.test-8081",
		engine: "colibri",
		host: "fleet-b.test",
		port: 8081,
		discovery: "stale",
		models: ["demo-small-8b"],
		active: false,
	},
];

function demoStats(tokensPerSecond: number | null, todosDone: number): WireStats {
	return {
		tokens: { input: 1_500_000, output: 266_000, cacheRead: 40_000_000, cacheWrite: 210_000 },
		cacheHitPercent: 99.3,
		costUsd: 1.554,
		tokensPerSecond,
		diff: { added: 850, removed: 148 },
		todos: { done: todosDone, total: 6 },
	};
}

const THINKING =
	"The user wants the failing gate fixed. The check output points at the token sheet, so I should run the gate first, read the offender list, and only then touch the stylesheet. One command, then a small edit.";

const ANSWER_ONE = "I'll run the repo gate first so the fix targets the real offender, not a guess.";

const ANSWER_TWO = [
	"The gate is green again. Two things changed:",
	"",
	"1. `shell.css` hardcoded a raw gap; it now reads `--rc-space-3`.",
	"2. The **tokens gate** had no case for `rem` lengths, so I added one.",
	"",
	"```ts",
	"const rem = /\\b\\d+(?:\\.\\d+)?rem\\b/g;",
	"for (const match of text.matchAll(rem)) offenses.push(match[0]);",
	"```",
	"",
	"> Nothing is committed yet. Run `npm run check` once more before you ship.",
	"",
	"| file | change |",
	"| --- | --- |",
	"| `shell.css` | 1 token swap |",
	"| `tokens-gate.test.ts` | 1 new rule |",
].join("\n");

const TOOL_OUTPUT = [
	"> hummin@0.1.0 check",
	"> biome check . && tsc --noEmit",
	"",
	"Checked 412 files in 1.9s. No fixes applied.",
	"tsc: 0 errors",
].join("\n");

/** Starts the demo for one fake host. Only the primary demo host plays the
 * script; the others just report their connection state. */
export function startDemo(options: {
	host: HostEntry;
	fixture: string;
	onEvent(event: AnyRemoteEvent): void;
	onState(state: ConnectionState): void;
}): DemoSession {
	const { host, fixture, onEvent, onState } = options;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let closed = false;
	let seq = 0;
	let turn = 0;
	let clock = 0;
	let pendingHold: { id: string; resume(): void } | null = null;

	const emit = <K extends RemoteEventType>(type: K, payload: RemoteEventPayloadMap[K]): void => {
		if (closed) return;
		seq += 1;
		onEvent({ v: 1, seq, ts: new Date().toISOString(), type, payload } as AnyRemoteEvent);
	};
	/** Queues a step on the script clock, delayMs after the previous step. */
	const step = (delayMs: number, run: () => void): void => {
		clock += delayMs;
		const timer = setTimeout(() => {
			timers.delete(timer);
			run();
		}, clock);
		timers.add(timer);
	};
	const clearTimers = (): void => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		clock = 0;
	};
	let todosDone = 4;
	const status = (
		kind: WireStatus["kind"],
		percent: number,
		detail?: string,
		tokensPerSecond: number | null = null,
	): void => {
		emit("status", {
			status: {
				kind,
				detail,
				model: MODEL,
				thinkingLevel: "medium",
				contextUsage: { tokens: percent * 1310, contextWindow: 131072, percent },
				stats: demoStats(tokensPerSecond, todosDone),
				workspace: WORKSPACE,
				autoCompact: true,
				version: "1.10.2",
			},
		});
	};
	const streamText = (
		slotKey: string,
		contentIndex: number,
		text: string,
		kind: "text_delta" | "thinking_delta",
		paceMs: number,
		speedPercent?: number,
	): void => {
		let index = 0;
		for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) {
			const at = index++;
			step(paceMs, () => {
				emit("message_delta", { slotKey, event: { type: kind, contentIndex, delta: chunk } });
				if (speedPercent !== undefined && at % 6 === 0) {
					status(
						"working",
						speedPercent,
						undefined,
						TOKENS_PER_SECOND[(at / 6) % TOKENS_PER_SECOND.length] ?? null,
					);
				}
			});
		}
	};

	const playTurn = (userText: string | null): void => {
		clearTimers();
		turn += 1;
		const first = `demo-${turn}-a`;
		const second = `demo-${turn}-b`;
		const callId = `demo-call-${turn}`;
		const holdId = `demo-hold-${turn}`;
		const args = { command: "npm run check" };
		if (userText !== null) {
			const message: WireAgentMessage = { role: "user", blocks: [{ type: "text", text: userText }] };
			emit("message_end", { slotKey: `demo-${turn}-user`, entryId: `demo-${turn}-user`, message });
		}
		step(200, () => {
			todosDone = 4;
			status("working", 34);
		});
		step(300, () => emit("message_start", { slotKey: first, message: { role: "assistant", blocks: [] } }));
		streamText(first, 0, THINKING, "thinking_delta", 24);
		streamText(first, 1, ANSWER_ONE, "text_delta", 34, 34);
		step(200, () => emit("message_delta", { slotKey: first, event: { type: "toolcall_start", contentIndex: 2 } }));
		step(120, () =>
			emit("message_delta", {
				slotKey: first,
				event: { type: "toolcall_delta", contentIndex: 2, delta: JSON.stringify(args) },
			}),
		);
		step(120, () => emit("message_delta", { slotKey: first, event: { type: "toolcall_end", contentIndex: 2 } }));
		step(150, () =>
			emit("message_end", {
				slotKey: first,
				entryId: first,
				message: {
					role: "assistant",
					blocks: [
						{ type: "thinking", text: THINKING },
						{ type: "text", text: ANSWER_ONE },
						{ type: "toolCall", id: callId, name: "bash", arguments: args },
					],
				},
			}),
		);
		step(250, () => {
			status("waiting", 36, "approval");
			emit("approval", {
				holds: [
					{
						id: holdId,
						toolName: "bash",
						argsPreview: args.command,
						deadlineMs: Date.now() + 30_000,
						createdAt: new Date().toISOString(),
					},
				],
			});
			// The script parks here until approve, deny, or the 8s fail-open expiry.
			const resume = (): void => {
				if (pendingHold?.id !== holdId) return;
				pendingHold = null;
				clearTimers();
				emit("approval_done", { id: holdId, resolution: "allowed" });
				afterApproval();
			};
			pendingHold = { id: holdId, resume };
			const expiry = setTimeout(resume, 8000);
			timers.add(expiry);
		});

		const afterApproval = (): void => {
			step(100, () => {
				todosDone = 5;
				status("working", 36);
				emit("tool_update", { toolCallId: callId, phase: "start", toolName: "bash", args });
			});
			step(900, () =>
				emit("tool_update", {
					toolCallId: callId,
					phase: "update",
					toolName: "bash",
					partialResult: TOOL_OUTPUT.split("\n").slice(0, 2).join("\n"),
				}),
			);
			step(900, () => emit("tool_update", { toolCallId: callId, phase: "end", toolName: "bash", durationMs: 1900 }));
			step(60, () =>
				emit("message_end", {
					slotKey: `${first}-result`,
					entryId: `${first}-result`,
					message: {
						role: "toolResult",
						toolCallId: callId,
						toolName: "bash",
						durationMs: 1900,
						blocks: [{ type: "text", text: TOOL_OUTPUT }],
					},
				}),
			);
			step(60, () =>
				emit("queue", {
					queue: {
						items: [{ id: `demo-q-${turn}`, preview: "then update the changelog", deliverAs: "followUp" }],
						terminalQueued: 1,
					},
				}),
			);
			step(200, () => emit("activity", { activity: { kind: "compaction", phase: "start" } }));
			step(1500, () => emit("activity", { activity: { kind: "compaction", phase: "end" } }));
			step(300, () => emit("message_start", { slotKey: second, message: { role: "assistant", blocks: [] } }));
			streamText(second, 0, ANSWER_TWO, "text_delta", 30, 36);
			step(200, () =>
				emit("message_end", {
					slotKey: second,
					entryId: second,
					message: { role: "assistant", blocks: [{ type: "text", text: ANSWER_TWO }] },
				}),
			);
			step(100, () => {
				emit("queue", { queue: { items: [], terminalQueued: 0 } });
				todosDone = 6;
				status("idle", 41);
			});
		};
	};

	const idleSnapshot = (messages: RemoteEventPayloadMap["snapshot"]["messages"]): void => {
		emit("snapshot", {
			host: { origin: host.origin, label: host.label },
			protocolVersion: 1,
			sessionId: "demo-session",
			sessionName: "remote-console premium pass",
			status: {
				kind: "idle",
				model: MODEL,
				thinkingLevel: "medium",
				contextUsage: { tokens: 40_000, contextWindow: 131072, percent: 31 },
				stats: demoStats(null, todosDone),
				workspace: WORKSPACE,
				autoCompact: true,
				version: "1.10.2",
			},
			messages,
			holds: [],
			queue: { items: [], terminalQueued: 0 },
			fleet: FLEET,
		});
	};

	if (host.origin !== DEMO_ORIGIN) {
		onState(host.origin.endsWith("unauthorized") ? "unauthorized" : "reconnecting");
		return { prompt() {}, resolveApproval() {}, abort() {}, close() {} };
	}

	onState("connecting");
	const begin = (messages: RemoteEventPayloadMap["snapshot"]["messages"]): void => {
		if (closed) return;
		onState("connected");
		idleSnapshot(messages);
		step(900, () => playTurn("the tokens gate is failing on main, fix it"));
	};
	if (fixture === "empty") {
		const timer = setTimeout(() => begin([]), 1200);
		timers.add(timer);
	} else {
		void fetch(`./harness/fixtures/${fixture}.events.json`)
			.then((response) => response.json())
			.then((events: AnyRemoteEvent[]) => {
				const snapshot = events.find((event) => event.type === "snapshot");
				begin(snapshot !== undefined && snapshot.type === "snapshot" ? snapshot.payload.messages : []);
			})
			.catch(() => onState("unreachable"));
	}

	return {
		prompt(text) {
			playTurn(text);
		},
		resolveApproval(id, allow) {
			if (pendingHold?.id !== id) return;
			if (allow) {
				pendingHold.resume();
				return;
			}
			pendingHold = null;
			clearTimers();
			emit("approval_done", { id, resolution: "denied" });
			status("idle", 36);
		},
		abort() {
			pendingHold = null;
			clearTimers();
			emit("approval", { holds: [] });
			status("idle", 36);
		},
		close() {
			closed = true;
			clearTimers();
		},
	};
}
