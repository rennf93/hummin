#!/usr/bin/env node

// Compares an offline bench results file with bench/baseline.json.
//   node bench/compare.mjs <results.json | results dir (newest offline file)> [--baseline <file>] [--update]
// Exit 1 on regression. Wall time is printed, never gated: it is dominated by CLI startup on shared runners.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));

export function compare(results, baseline) {
	const failures = [];
	const report = [];
	if (!Array.isArray(results) || results.length === 0) throw new Error("results contain no fixtures");
	const byFixture = new Map(results.map((r) => [r.fixture, r]));
	for (const name of byFixture.keys()) {
		if (!(name in baseline.fixtures)) failures.push(`${name}: not in baseline, run --update to add it`);
	}
	for (const [name, expected] of Object.entries(baseline.fixtures)) {
		const actual = byFixture.get(name);
		if (!actual) {
			failures.push(`${name}: missing from results`);
			continue;
		}
		if (expected.pass && !actual.pass) failures.push(`${name}: pass rate dropped (now failing)`);
		if (actual.toolErrors > expected.toolErrors) {
			failures.push(`${name}: toolErrors ${expected.toolErrors} -> ${actual.toolErrors}`);
		}
		if (Math.abs(actual.toolCalls - expected.toolCalls) > baseline.toolCallTolerance) {
			failures.push(
				`${name}: toolCalls ${expected.toolCalls} -> ${actual.toolCalls} (tolerance ${baseline.toolCallTolerance})`,
			);
		}
		report.push(`${name}: ${actual.durationSec}s (baseline ${expected.durationSec}s, report-only)`);
	}
	return { failures, report };
}

export function toBaseline(results, toolCallTolerance = 0) {
	return {
		toolCallTolerance,
		fixtures: Object.fromEntries(
			results.map((r) => [
				r.fixture,
				{ pass: r.pass, toolCalls: r.toolCalls, toolErrors: r.toolErrors, durationSec: r.durationSec },
			]),
		),
	};
}

function main() {
	const args = process.argv.slice(2);
	const flag = args.indexOf("--baseline");
	const baselinePath = flag >= 0 ? args[flag + 1] : join(root, "baseline.json");
	const resultsPath = args.find((arg, i) => !arg.startsWith("--") && (flag < 0 || i !== flag + 1));
	if (!resultsPath) {
		console.error("usage: node bench/compare.mjs <results.json> [--baseline <file>] [--update]");
		process.exit(2);
	}
	let resultsFile = resultsPath;
	if (statSync(resultsPath).isDirectory()) {
		const newest = readdirSync(resultsPath)
			.filter((name) => name.endsWith("_bench-faux.json"))
			.sort()
			.at(-1);
		if (!newest) throw new Error(`no *_bench-faux.json in ${resultsPath}`);
		resultsFile = join(resultsPath, newest);
	}
	const { results } = JSON.parse(readFileSync(resultsFile, "utf8"));
	if (args.includes("--update")) {
		writeFileSync(baselinePath, `${JSON.stringify(toBaseline(results), null, "\t")}\n`);
		console.log(`baseline written: ${baselinePath}`);
		process.exit(0);
	}
	const { failures, report } = compare(results, JSON.parse(readFileSync(baselinePath, "utf8")));
	for (const line of report) console.log(line);
	for (const failure of failures) console.error(`REGRESSION ${failure}`);
	console.log(failures.length ? `FAIL: ${failures.length} regression(s)` : "OK: no regressions");
	process.exit(failures.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
