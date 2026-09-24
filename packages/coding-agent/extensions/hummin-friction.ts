// hummin-friction: the /friction command. Prints a plain-text summary of the
// friction log (last 7 days): totals by kind, per-day counts, plus laya gate
// activity and threshold calibration from laya-gate.log. Data collection lives
// in lib/friction.ts and is fail-silent; this file only reads, renders, and
// registers the command.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layaGateThreshold } from "./hummin-laya.ts";
import {
	FRICTION_KINDS,
	parseLayaGateEntry,
	readFrictionEvents,
	readLayaGateLines,
	summarizeFriction,
	summarizeLayaCalibration,
	summarizeLayaGate,
	type FrictionSummary,
	type LayaCalibration,
	type LayaGateSummary,
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

/** Plain-text /friction report. Pure; exported for tests. */
export function renderFrictionReport(
	friction: FrictionSummary,
	laya: LayaGateSummary,
	calibration?: LayaCalibration,
): string {
	if (friction.total === 0 && laya.block + laya.confirmed + laya.read === 0) {
		return `No friction recorded in the last ${FRICTION_REPORT_DAYS} days.`;
	}
	const sections = [
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

export default function humminFriction(pi: ExtensionAPI): void {
	pi.registerCommand("friction", {
		description: "Show agent friction summary (tool errors, denials, advisories, laya gate)",
		category: "Usage",
		handler: async (_args, ctx: ExtensionContext) => {
			const summary = summarizeFriction(readFrictionEvents(FRICTION_REPORT_DAYS), { days: FRICTION_REPORT_DAYS });
			const lines = readLayaGateLines();
			const laya = summarizeLayaGate(lines);
			const calibration = summarizeLayaCalibration(
				lines.map((line) => parseLayaGateEntry(line)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
				{ threshold: layaGateThreshold() },
			);
			ctx.ui.notify(renderFrictionReport(summary, laya, calibration), "info");
		},
	});
}
