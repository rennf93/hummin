// hummin-friction: the /friction command. Prints the live per-source counts
// for the current session (fed by hummin-guardrails via lib/friction.ts)
// above a plain-text summary of the friction log (last 7 days): totals by
// kind, per-day counts, plus laya gate activity and threshold calibration
// from laya-gate.log. The calibration's suggested threshold can be applied
// directly from the command (persisted to global settings, atomic write).
// Data collection lives in lib/friction.ts and is fail-silent; this file only
// reads, renders, and registers the command.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { layaGateThreshold } from "./hummin-laya.ts";
import {
	FRICTION_KINDS,
	parseLayaGateEntry,
	readFrictionEvents,
	readLayaGateLines,
	sessionFrictionTally,
	summarizeFriction,
	summarizeLayaCalibration,
	summarizeLayaGate,
	type FrictionSummary,
	type LayaCalibration,
	type LayaGateSummary,
	type SessionSourceCount,
} from "./lib/friction.ts";

export const FRICTION_REPORT_DAYS = 7;

/** /doctor-style aligned two-column table text. */
function formatRows(rows: ReadonlyArray<readonly [string, string]>): string {
	const width = Math.max(...rows.map(([label]) => label.length));
	return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

const pct2 = (n: number): string => n.toFixed(2);

/** Calibration rows for the laya gate, or [] when there is nothing to
 * calibrate on (no blocks, no confirms, no near-misses). Pure; exported for
 * tests via renderFrictionReport. */
export function layaCalibrationRows(calibration: LayaCalibration): ReadonlyArray<readonly [string, string]> {
	if (calibration.blocks === 0 && calibration.confirmed === 0 && calibration.nearMisses === 0) return [];
	const rows: Array<readonly [string, string]> = [];
	if (calibration.blockP) {
		rows.push([
			"blocks",
			`${calibration.blocks} (P ${pct2(calibration.blockP.min)}-${pct2(calibration.blockP.max)}, median ${pct2(calibration.blockP.median)})`,
		]);
	} else {
		rows.push(["blocks", "0"]);
	}
	const known = calibration.confirmedScores.length > 0 ? ` (lowest P ${pct2(Math.min(...calibration.confirmedScores))})` : "";
	rows.push(["confirmed", `${calibration.confirmed}${known}`]);
	if (calibration.nearMisses > 0) {
		rows.push([
			"near-miss reads",
			`${calibration.nearMisses} passed at 0.50-${pct2(calibration.threshold)}${calibration.nearMissMax !== undefined ? ` (max ${pct2(calibration.nearMissMax)})` : ""}`,
		]);
	}
	if (calibration.suggestedThreshold !== undefined) {
		rows.push([
			"suggestion",
			`lowest confirmed P ${pct2(Math.min(...calibration.confirmedScores))} still blocks at ${pct2(calibration.threshold)}; consider settings layaGateThreshold ${pct2(calibration.suggestedThreshold)}`,
		]);
	}
	return rows;
}

/** Rows for the live per-source session counts. Pure; exported for tests. */
export function sessionSectionRows(counts: readonly SessionSourceCount[]): ReadonlyArray<readonly [string, string]> {
	return counts.map((entry) => {
		const parts: string[] = [];
		if (entry.toolErrors > 0) parts.push(`tool_error ${entry.toolErrors}`);
		if (entry.toolRejections > 0) parts.push(`tool_rejected ${entry.toolRejections}`);
		return [entry.source, parts.join(", ") || "0"] as const;
	});
}

/** Plain-text /friction report. Pure; exported for tests. The optional
 * session counts render as the leading "this session" section. */
export function renderFrictionReport(
	friction: FrictionSummary,
	laya: LayaGateSummary,
	calibration?: LayaCalibration,
	session: readonly SessionSourceCount[] = [],
): string {
	const hasSession = session.length > 0;
	if (friction.total === 0 && laya.block + laya.confirmed + laya.read === 0 && !hasSession) {
		return `No friction recorded in the last ${FRICTION_REPORT_DAYS} days.`;
	}
	const sections = [
		...(hasSession ? (["this session", formatRows(sessionSectionRows(session)), ""] as const) : []),
		`Friction, last ${FRICTION_REPORT_DAYS} days (total ${friction.total})`,
		formatRows(FRICTION_KINDS.map((kind) => [kind, String(friction.byKind[kind])] as const)),
		"",
		"per day",
		formatRows(friction.perDay.map((entry) => [entry.day, String(entry.count)] as const)),
		"",
		"laya gate (all time)",
		formatRows(layaRows(laya)),
	];
	const calibrationRows = calibration ? layaCalibrationRows(calibration) : [];
	if (calibrationRows.length > 0) {
		sections.push("", `laya calibration (threshold ${pct2(calibration?.threshold ?? 0.75)})`, formatRows(calibrationRows));
	}
	return sections.join("\n");
}

function layaRows(laya: LayaGateSummary): ReadonlyArray<readonly [string, string]> {
	return [
		["block", String(laya.block)],
		["confirmed", String(laya.confirmed)],
		["read", String(laya.read)],
	] as const;
}

/**
 * Persist `layaGateThreshold` to the global settings file (atomic tmp+rename,
 * same pattern as the sandbox mode toggle). The gate resolves the threshold
 * from settings on every command, so the change applies to new gate reads
 * immediately; a project settings `layaGateThreshold` would still mask it.
 */
export async function applySuggestedThreshold(suggested: number, agentDir: string = getAgentDir()): Promise<void> {
	const path = join(agentDir, "settings.json");
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		parsed = {};
	}
	parsed.layaGateThreshold = suggested;
	const temp = `${path}.tmp-${process.pid}`;
	await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

export default function humminFriction(pi: ExtensionAPI): void {
	pi.registerCommand("friction", {
		description: "Show agent friction summary (tool errors, denials, advisories, laya gate)",
		category: "Usage",
		handler: async (_args, ctx: ExtensionContext) => {
			const summary = summarizeFriction(readFrictionEvents(FRICTION_REPORT_DAYS), { days: FRICTION_REPORT_DAYS });
			const session = sessionFrictionTally().snapshot();
			const lines = readLayaGateLines();
			const laya = summarizeLayaGate(lines);
			const calibration = summarizeLayaCalibration(
				lines.map((line) => parseLayaGateEntry(line)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
				{ threshold: layaGateThreshold() },
			);
			ctx.ui.notify(renderFrictionReport(summary, laya, calibration, session), "info");
			const suggested = calibration?.suggestedThreshold;
			if (suggested === undefined) return;
			const choice = await ctx.ui.select(
				"laya gate calibration",
				[`Apply suggested layaGateThreshold ${suggested.toFixed(2)} (persisted globally)`, "Leave as is"],
			);
			if (!choice || !choice.startsWith("Apply")) return;
			try {
				await applySuggestedThreshold(suggested);
				ctx.ui.notify(`layaGateThreshold ${suggested.toFixed(2)} written to global settings; new gate reads use it immediately.`, "info");
			} catch (error) {
				ctx.ui.notify(`friction: could not persist threshold (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
		},
	});
}
