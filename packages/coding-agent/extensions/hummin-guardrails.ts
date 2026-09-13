/**
 * hummin-guardrails: runaway protection for agent sessions, adapted from the
 * RoboCo harness (foundation/policy/agent_loop.py, agent_sdk/server.py).
 *
 * Three mechanisms, all session-local and fail-open:
 * - Budget: cumulative tool-call counter with an in-band warning threshold and
 *   a hard halt. Reminders are appended to tool results so the model sees them
 *   next turn (in-band beats silent kills).
 * - Loop: a rolling window of sha256(tool+args) hashes; the 3rd identical call
 *   inside the window is denied with remediation text.
 * - Circuit: per-tool rejection windows plus a session-absolute cap, so a tool
 *   failing every few minutes ("slow drip") still trips a breaker.
 *
 * Configure via environment (all optional):
 *   HUMMIN_BUDGET_TOOL_CALL_WARN_AT (100), HUMMIN_BUDGET_TOOL_CALL_HALT_AT (300),
 *   HUMMIN_BUDGET_LOOP_THRESHOLD (3), HUMMIN_BUDGET_LOOP_WINDOW (10),
 *   HUMMIN_BUDGET_PER_TOOL_WINDOW_MS (60000), HUMMIN_BUDGET_PER_TOOL_RETRY_LIMIT (8),
 *   HUMMIN_BUDGET_ABSOLUTE_RETRY_MULTIPLIER (3), HUMMIN_BUDGET_EXEMPT_VERBS (read,grep,find,ls)
 *   HUMMIN_GUARDRAILS=0 disables the extension.
 *
 * Post-mortems land in ~/.hummin/agent/post-mortems/.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface BudgetPolicy {
	toolCallWarnAt: number;
	toolCallHaltAt: number;
	loopThreshold: number;
	loopWindow: number;
	perToolRetryWindowMs: number;
	perToolRetryLimit: number;
	absoluteRetryMultiplier: number;
	exemptVerbs: readonly string[];
}

export function defaultPolicy(env: NodeJS.ProcessEnv = process.env): BudgetPolicy {
	const num = (key: string, fallback: number): number => {
		const raw = env[key];
		const parsed = raw === undefined ? Number.NaN : Number(raw);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	};
	return {
		toolCallWarnAt: num("HUMMIN_BUDGET_TOOL_CALL_WARN_AT", 100),
		toolCallHaltAt: num("HUMMIN_BUDGET_TOOL_CALL_HALT_AT", 300),
		loopThreshold: num("HUMMIN_BUDGET_LOOP_THRESHOLD", 3),
		loopWindow: num("HUMMIN_BUDGET_LOOP_WINDOW", 10),
		perToolRetryWindowMs: num("HUMMIN_BUDGET_PER_TOOL_WINDOW_MS", 60000),
		perToolRetryLimit: num("HUMMIN_BUDGET_PER_TOOL_RETRY_LIMIT", 8),
		absoluteRetryMultiplier: num("HUMMIN_BUDGET_ABSOLUTE_RETRY_MULTIPLIER", 3),
		exemptVerbs: (env.HUMMIN_BUDGET_EXEMPT_VERBS ?? "read,grep,find,ls").split(",").map((verb) => verb.trim()),
	};
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashToolCall(toolName: string, input: unknown): string {
	return createHash("sha256")
		.update(`${toolName}:${stableStringify(input)}`)
		.digest("hex")
		.slice(0, 16);
}

export type CallDecision = { allowed: true } | { allowed: false; reason: string };

type Clock = () => number;

/**
 * Session-local guard state. Clock is injectable for deterministic tests.
 */
export class GuardrailsState {
	readonly policy: BudgetPolicy;
	readonly perTool: Map<string, number> = new Map();
	totalToolCalls = 0;
	halted = false;
	private hashes: { hash: string; at: number }[] = [];
	private rejections: Map<string, number[]> = new Map();
	private readonly clock: Clock;

	constructor(policy: BudgetPolicy = defaultPolicy(), clock: Clock = Date.now) {
		this.policy = policy;
		this.clock = clock;
	}

	observeCall(toolName: string, input: unknown): CallDecision {
		const at = this.clock();
		if (this.halted) {
			return {
				allowed: false,
				reason: `[Budget] Tool budget exhausted (${this.policy.toolCallHaltAt}). Stop calling tools, summarize your findings, and hand back to the human.`,
			};
		}
		this.totalToolCalls += 1;
		this.perTool.set(toolName, (this.perTool.get(toolName) ?? 0) + 1);
		if (this.totalToolCalls > this.policy.toolCallHaltAt) {
			this.halted = true;
			return {
				allowed: false,
				reason: `[Budget] ${this.totalToolCalls}/${this.policy.toolCallHaltAt} tool calls - halt. Summarize what you have and hand back to the human.`,
			};
		}
		if (!this.policy.exemptVerbs.includes(toolName)) {
			const hash = hashToolCall(toolName, input);
			this.hashes.push({ hash, at });
			if (this.hashes.length > this.policy.loopWindow) this.hashes.shift();
			const hits = this.hashes.filter((entry) => entry.hash === hash).length;
			if (hits >= this.policy.loopThreshold) {
				this.hashes.pop(); // denied calls do not consume the window
				return {
					allowed: false,
					reason: `[Loop] identical ${toolName} call x${hits} in the last ${this.policy.loopWindow} calls - denied. Change approach, or stop and tell the human what you actually need.`,
				};
			}
			const rejects = this.rejections.get(toolName);
			if (rejects) {
				const cutoff = at - this.policy.perToolRetryWindowMs;
				const recent = rejects.filter((stamp) => stamp >= cutoff).length;
				const absolute = rejects.length;
				if (
					recent >= this.policy.perToolRetryLimit ||
					absolute >= this.policy.perToolRetryLimit * this.policy.absoluteRetryMultiplier
				) {
					return {
						allowed: false,
						reason: `[Circuit] ${toolName} has failed ${absolute} time(s) (${recent} in the last minute) - circuit open. Investigate the root cause or ask the human instead of retrying.`,
					};
				}
			}
		}
		return { allowed: true };
	}

	// Returns an in-band reminder to append to the tool result, if one is due.
	observeResult(toolName: string, isError: boolean): string | undefined {
		const at = this.clock();
		if (isError) {
			const stamps = this.rejections.get(toolName) ?? [];
			stamps.push(at);
			this.rejections.set(toolName, stamps);
			return undefined;
		}
		if (this.totalToolCalls >= this.policy.toolCallWarnAt && !this.halted) {
			return `[Budget] ${this.totalToolCalls}/${this.policy.toolCallHaltAt} tool calls used. Plan your remaining work carefully.`;
		}
		return undefined;
	}
}

function writePostMortem(state: GuardrailsState): void {
	try {
		const dir = join(homedir(), ".hummin", "agent", "post-mortems");
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const record = {
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			totalToolCalls: state.totalToolCalls,
			perTool: Object.fromEntries(state.perTool),
			halted: state.halted,
		};
		writeFileSync(join(dir, `${stamp}.json`), `${JSON.stringify(record, null, 1)}\n`);
	} catch {
		// fail-open: post-mortems must never block shutdown
	}
}

export default function humminGuardrails(pi: ExtensionAPI): void {
	if (process.env.HUMMIN_GUARDRAILS === "0") {
		return;
	}
	const state = new GuardrailsState(defaultPolicy(process.env));

	pi.on("tool_call", async (event) => {
		const decision = state.observeCall(event.toolName, event.input);
		if (!decision.allowed) {
			return { block: true, reason: decision.reason };
		}
	});

	pi.on("tool_result", async (event) => {
		const reminder = state.observeResult(event.toolName, event.isError);
		if (reminder) {
			event.content.push({ type: "text", text: reminder });
		}
	});

	pi.on("session_shutdown", async () => {
		writePostMortem(state);
	});
}
