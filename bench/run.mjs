#!/usr/bin/env node

// hummin bench: golden-task harness for measuring agent changes and providers.
// Runs each fixture headless through the real hummin CLI in a disposable dir,
// scores deterministically via the fixture's check.mjs, and stamps results
// with a config hash so runs are attributable. LLM-judge scoring is v2.
//
// Usage:
//   node bench/run.mjs --provider colibri-1 --model glm-5.3-flash-colibri
//   node bench/run.mjs --provider zai --model glm-5.3-flash [--fixture fix-bug]
//        [--thinking off] [--timeout 900] [--model-id <id>] [--provider-label <label>]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureEvents } from "./metrics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.HUMMIN_BENCH_CLI ?? join(ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js");
const FIXTURES_DIR = join(ROOT, "bench", "fixtures");
const RESULTS_DIR = process.env.HUMMIN_BENCH_RESULTS_DIR ?? join(ROOT, "bench", "results");

function argValue(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const provider = argValue("--provider");
const model = argValue("--model");
const modelId = argValue("--model-id", model);
const providerLabel = argValue("--provider-label", provider);
const thinking = argValue("--thinking", "off");
const timeoutSec = Number(argValue("--timeout", "900"));
const onlyFixture = argValue("--fixture");
const validate = process.argv.includes("--validate-fixtures");
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("Invalid timeout");

if (!validate && (!provider || !model)) {
	console.error(
		"usage: node bench/run.mjs --provider <id> --model <id> [--fixture <name>] [--thinking off] [--timeout 900]",
	);
	process.exit(2);
}

const fixtureNames = listFixtures().filter((f) => !onlyFixture || f === onlyFixture);

function prepareFixture(fixture, work) {
	cpSync(join(fixture, "files"), work, { recursive: true });
	const setup = join(fixture, "setup.mjs");
	if (existsSync(setup)) {
		const result = spawnSync(process.execPath, [setup], { cwd: work, encoding: "utf8", timeout: 10000 });
		if (result.status !== 0) throw new Error(`Fixture setup failed: ${result.stderr}`);
	}
}

function listFixtures() {
	try {
		return readdirSync(FIXTURES_DIR).filter((name) => existsSync(join(FIXTURES_DIR, name, "task.md")));
	} catch {
		return [];
	}
}

if (fixtureNames.length === 0) {
	console.error(`no fixtures found in ${FIXTURES_DIR}`);
	process.exit(2);
}

if (validate) {
	let checked = 0;
	for (const name of fixtureNames) {
		const fixture = join(FIXTURES_DIR, name);
		if (!existsSync(join(fixture, "reference"))) continue;
		const work = mkdtempSync("/tmp/hummin-bench-validate-");
		try {
			prepareFixture(fixture, work);
			const output = join(work, ".agent-output.txt");
			writeFileSync(output, "");
			const check = () =>
				spawnSync(process.execPath, [join(fixture, "check.mjs"), output], {
					cwd: work,
					encoding: "utf8",
					timeout: 10000,
				});
			if (check().status === 0) throw new Error(`${name}: initial broken fixture incorrectly passes`);
			cpSync(join(fixture, "reference"), work, { recursive: true });
			const result = check();
			if (result.status !== 0) throw new Error(`${name}: reference fix fails: ${result.stderr}`);
			console.log(`PASS checker sensitivity: ${name}`);
			checked++;
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
	if (!checked) throw new Error("No reference fixtures selected");
	process.exit(0);
}

const piConfig =
	JSON.parse(readFileSync(join(ROOT, "packages", "coding-agent", "package.json"), "utf8")).piConfig ?? {};
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim();
const cliHash = createHash("sha256").update(readFileSync(CLI)).digest("hex");
const configHash = createHash("sha256")
	.update(JSON.stringify({ piConfig, revision, cliHash, provider, model, thinking }))
	.digest("hex")
	.slice(0, 12);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(RESULTS_DIR, { recursive: true });

console.log(`hummin bench | run ${runId} | config ${configHash}`);
console.log(`provider=${providerLabel} model=${modelId} thinking=${thinking} timeout=${timeoutSec}s`);
console.log(`fixtures: ${fixtureNames.join(", ")}\n`);

const results = [];
for (const name of fixtureNames) {
	const fixtureDir = join(FIXTURES_DIR, name);
	const workDir = mkdtempSync(`/tmp/hummin-bench-${name}-`);
	prepareFixture(fixtureDir, workDir);

	const brief = readFileSync(join(fixtureDir, "task.md"), "utf8").trim();
	const started = Date.now();
	let agentOutput = "";
	let agentExit = null;
	let agentError = "";
	let stderr = "";
	try {
		const res = spawnSync(
			process.execPath,
			[CLI, "--mode", "json", "-p", brief, "--provider", provider, "--model", model, "--thinking", thinking],
			{
				cwd: workDir,
				encoding: "utf8",
				timeout: timeoutSec * 1000,
				env: { ...process.env, HUMMIN_MEMORY: "0" },
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 32 * 1024 * 1024,
				killSignal: "SIGKILL",
			},
		);
		agentExit = res.status;
		agentOutput = res.stdout ?? "";
		stderr = res.stderr ?? "";
		agentError = res.error ? String(res.error) : "";
	} catch (e) {
		agentError = String(e);
	}
	const durationMs = Date.now() - started;

	// Persist the agent's visible output for the check script and the record.
	const outFile = join(workDir, ".agent-output.txt");
	const metrics = measureEvents(agentOutput);
	writeFileSync(outFile, metrics.finalText);
	writeFileSync(join(RESULTS_DIR, `${runId}_${name}.events.jsonl`), agentOutput);
	writeFileSync(join(RESULTS_DIR, `${runId}_${name}.stderr.txt`), stderr);

	const checkPath = join(fixtureDir, "check.mjs");
	let checkPass = false;
	let checkOutput = "";
	try {
		const check = spawnSync(process.execPath, [checkPath, outFile], {
			encoding: "utf8",
			timeout: 120_000,
			cwd: workDir,
		});
		checkPass = check.status === 0 && agentExit === 0 && !agentError;
		checkOutput = `${check.stdout ?? ""}${check.stderr ?? ""}`.trim();
	} catch (e) {
		checkOutput = String(e);
	}

	// Keep evidence, drop the heavy working copy unless it failed.
	if (checkPass) rmSync(workDir, { recursive: true, force: true });

	results.push({
		runId,
		configHash,
		revision,
		cliHash,
		fixtureHash: createHash("sha256").update(brief).update(readFileSync(checkPath)).digest("hex"),
		toolCalls: metrics.toolCalls,
		toolErrors: metrics.toolErrors,
		tokens: metrics.tokens,
		compactions: metrics.compactions,
		approvalRequests: metrics.approvalRequests,
		humanInterventions: 0,
		unattended: true,
		agentError,
		retainedWorkDir: checkPass ? null : workDir,
		timestamp: new Date().toISOString(),
		fixture: name,
		provider,
		providerLabel,
		model: modelId,
		thinking,
		pass: checkPass,
		agentExit,
		durationMs,
		durationSec: Math.round(durationMs / 100) / 10,
		checkOutput,
		agentOutputHead: metrics.finalText.slice(0, 2000),
	});
	console.log(
		`${checkPass ? "PASS" : "FAIL"}  ${name.padEnd(14)} ${results.at(-1).durationSec}s  ${checkOutput.split("\n")[0]}`,
	);
}

const resultFile = join(RESULTS_DIR, `${runId}_${providerLabel.replace(/[^a-z0-9-]/gi, "_")}.json`);
writeFileSync(resultFile, `${JSON.stringify({ configHash, providerLabel, results }, null, 1)}\n`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed | results: ${resultFile}`);
process.exit(passed === results.length ? 0 : 1);
