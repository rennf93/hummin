/**
 * lib/child-acceptance: the child result acceptance read (hummin-plan.md T3.3).
 *
 * One System-1 noul read at child exit: P(this result is on-task and
 * complete), judged from the brief and the child's final report. Advisory
 * only in v1: the score is attached to the result text the parent sees and
 * nothing is blocked, rewritten, or retried. Every outcome fails open: a
 * disabled, unconfigured, unreachable, or slow engine delivers the result
 * untouched, and the read never delays delivery past the dispatch timeout.
 *
 * Kill switch: HUMMIN_SYS1_ACCEPT=off (env). Every read that returned a
 * score is appended to sys1-gate.log as {ts, type: "read", kind: "accept", p},
 * the same shape as the other automatic reads.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveDecisionEngine, sys1Disabled, sys1Noul } from "./decision-engine.ts";

/** Char bound for the report excerpt inside the read state (conclusions live
 * at the end of a child report, so the tail is kept). */
export const ACCEPT_REPORT_MAX_CHARS = 2000;

/** Below this score the advisory tells the parent to inspect the result
 * before relying on it. Provisional until calibration data accumulates; the
 * score is attached either way, so the wording line is presentation only. */
export const ACCEPT_INSPECT_BELOW = 0.5;

/** Tighter than the dispatch timeout on purpose: the read is advisory and
 * runs between child exit and result delivery, so a slow engine delays
 * foreground results by at most this long. */
export const ACCEPT_READ_TIMEOUT_MS = 2_500;

/** After a failed read, skip further reads for this long: an engine that is
 * down or slow must not tax every child result with the same timeout. */
const FAILURE_RETRY_MS = 60_000;
const FAILURE_MEMO_KEY = Symbol.for("hummin.child-acceptance.last-failure");

/** The engine read's decision question. Deliberately short: the english
 * checkpoint runs a small context and long rubrics truncate. */
export const ACCEPTANCE_INSTRUCTIONS =
	"Score P(this child result is on task and complete). Off task means it answers a different question than the brief. Incomplete means it stops mid-work, admits it did not finish, or plainly lacks what the brief asked for.";

/** Pure: the bounded state text for the acceptance read. The report tail is
 * kept (child reports conclude at the end); a truncated report is marked so
 * the engine can weigh incompleteness honestly. */
export function acceptanceState(what: string, report: string, maxChars: number = ACCEPT_REPORT_MAX_CHARS): string {
	const trimmedReport = report.replace(/\s+$/, "");
	const body =
		trimmedReport.length > maxChars
			? `[report truncated to the last ${maxChars} of ${trimmedReport.length} chars]\n${trimmedReport.slice(trimmedReport.length - maxChars)}`
			: trimmedReport || "(no report captured)";
	return `A coding agent delegated this brief to a child session:\n\n${what}\n\nThe child's final report:\n\n${body}`;
}

/** Pure: the advisory line attached to the result text the parent sees. */
export function acceptanceNote(p: number): string {
	const base = `[sys1 acceptance] P(on-task, complete) = ${p.toFixed(2)}`;
	return p < ACCEPT_INSPECT_BELOW ? `${base} - inspect before relying on it` : base;
}

/** Audit trail: one JSON line per acceptance read that returned a score, same
 * shape as the other System-1 reads' audit lines (hummin-sys1.ts, ask-gate). */
function auditAcceptRead(p: number): void {
	try {
		appendFileSync(
			join(getAgentDir(), "sys1-gate.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), type: "read", kind: "accept", p })}\n`,
		);
	} catch {
		// Audit logging must never break the read itself.
	}
}

/**
 * The acceptance read for one finished child. Returns the score, or undefined
 * in every no-op case (disabled, unconfigured engine, failed or slow read) so
 * the caller attaches nothing. Never throws. The engine read is injectable
 * for tests; production resolves the active decision engine per call.
 */
export async function childAcceptanceCheck(params: {
	what: string;
	report: string;
	cwd: string;
	read?: (state: string, name: string, instructions: string) => Promise<{ noul: number } | null>;
}): Promise<number | undefined> {
	try {
		if (sys1Disabled("HUMMIN_SYS1_ACCEPT")) return undefined;
		const scope = globalThis as Record<symbol, number | undefined>;
		const lastFailure = scope[FAILURE_MEMO_KEY];
		if (lastFailure !== undefined && Date.now() - lastFailure < FAILURE_RETRY_MS) return undefined;
		const engine = resolveDecisionEngine(params.cwd);
		if (engine.unconfigured) return undefined;
		const read =
			params.read ??
			((state: string, name: string, instructions: string) => sys1Noul(engine, state, name, instructions, ACCEPT_READ_TIMEOUT_MS));
		const result = await read(acceptanceState(params.what, params.report), "acceptance", ACCEPTANCE_INSTRUCTIONS);
		const p = result?.noul;
		// Number.isFinite rejects NaN, which plain range checks let through.
		if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
			scope[FAILURE_MEMO_KEY] = Date.now();
			return undefined;
		}
		scope[FAILURE_MEMO_KEY] = undefined;
		auditAcceptRead(p);
		return p;
	} catch {
		// The advisory must never break result delivery.
		(globalThis as Record<symbol, number | undefined>)[FAILURE_MEMO_KEY] = Date.now();
		return undefined;
	}
}

/** Test-only: clear the failure memo so tests drive reads directly. */
export function resetAcceptanceFailureMemo(): void {
	(globalThis as Record<symbol, number | undefined>)[FAILURE_MEMO_KEY] = undefined;
}
