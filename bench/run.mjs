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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js");
const FIXTURES_DIR = join(ROOT, "bench", "fixtures");
const RESULTS_DIR = join(ROOT, "bench", "results");

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

if (!provider || !model) {
	console.error("usage: node bench/run.mjs --provider <id> --model <id> [--fixture <name>] [--thinking off] [--timeout 900]");
	process.exit(2);
}

const fixtureNames = listFixtures().filter((f) => !onlyFixture || f === onlyFixture);

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

const piConfig = JSON.parse(readFileSync(join(ROOT, "packages", "coding-agent", "package.json"), "utf8")).piConfig ?? {};
const configHash = createHash("sha256").update(JSON.stringify(piConfig)).digest("hex").slice(0, 12);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(RESULTS_DIR, { recursive: true });

console.log(`hummin bench | run ${runId} | config ${configHash}`);
console.log(`provider=${providerLabel} model=${modelId} thinking=${thinking} timeout=${timeoutSec}s`);
console.log(`fixtures: ${fixtureNames.join(", ")}\n`);

const results = [];
for (const name of fixtureNames) {
	const fixtureDir = join(FIXTURES_DIR, name);
	const workDir = join("/tmp", "hummin-bench", runId, name);
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	cpSync(join(fixtureDir, "files"), workDir, { recursive: true });

	const brief = readFileSync(join(fixtureDir, "task.md"), "utf8").trim();
	const started = Date.now();
	let agentOutput = "";
	let agentExit = null;
	try {
		const res = spawnSync(process.execPath, [CLI, "-p", brief, "--provider", provider, "--model", model, "--thinking", thinking], {
			cwd: workDir,
			encoding: "utf8",
			timeout: timeoutSec * 1000,
			env: process.env,
		});
		agentExit = res.status;
		agentOutput = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
	} catch (e) {
		agentOutput = String(e);
	}
	const durationMs = Date.now() - started;

	// Persist the agent's visible output for the check script and the record.
	const outFile = join(workDir, ".agent-output.txt");
	writeFileSync(outFile, agentOutput);

	const checkPath = join(fixtureDir, "check.mjs");
	let checkPass = false;
	let checkOutput = "";
	try {
		const check = spawnSync(process.execPath, [checkPath, outFile], { encoding: "utf8", timeout: 120_000, cwd: workDir });
		checkPass = check.status === 0;
		checkOutput = `${check.stdout ?? ""}${check.stderr ?? ""}`.trim();
	} catch (e) {
		checkOutput = String(e);
	}

	// Keep evidence, drop the heavy working copy unless it failed.
	if (checkPass) rmSync(workDir, { recursive: true, force: true });

	results.push({
		runId,
		configHash,
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
		agentOutputHead: agentOutput.slice(0, 2000),
	});
	console.log(`${checkPass ? "PASS" : "FAIL"}  ${name.padEnd(14)} ${results.at(-1).durationSec}s  ${checkOutput.split("\n")[0]}`);
}

const resultFile = join(RESULTS_DIR, `${runId}_${providerLabel.replace(/[^a-z0-9-]/gi, "_")}.json`);
writeFileSync(resultFile, `${JSON.stringify({ configHash, providerLabel, results }, null, 1)}\n`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed | results: ${resultFile}`);
process.exit(passed === results.length ? 0 : 1);
