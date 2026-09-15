import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
test("runner measures a mock CLI and fails when the agent exits unsuccessfully despite correct files", () => {
	const temp = mkdtempSync(join(tmpdir(), "hummin-bench-test-"));
	const retained = [];
	try {
		const cli = join(temp, "mock-cli.mjs");
		writeFileSync(
			cli,
			`import { cpSync } from "node:fs";
cpSync(${JSON.stringify(join(directory, "fixtures/multi-file/reference"))}, process.cwd(), { recursive: true });
if (process.env.HUMMIN_MEMORY !== "0") throw new Error("memory was not disabled");
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"one"}));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",timestamp:1,content:[{type:"text",text:"done"}],usage:{totalTokens:42}}}));
process.exitCode = Number(process.env.MOCK_EXIT || "0");
`,
		);
		for (const code of [0, 3]) {
			const resultsDir = join(temp, `results-${code}`);
			const run = spawnSync(
				process.execPath,
				[join(directory, "run.mjs"), "--provider", "mock", "--model", "mock", "--fixture", "multi-file"],
				{
					encoding: "utf8",
					timeout: 10000,
					env: {
						...process.env,
						HUMMIN_BENCH_CLI: cli,
						HUMMIN_BENCH_RESULTS_DIR: resultsDir,
						MOCK_EXIT: String(code),
					},
				},
			);
			assert.equal(run.status, code === 0 ? 0 : 1, run.stderr);
			const file = readdirSync(resultsDir).find((name) => name.endsWith("_mock.json"));
			const result = JSON.parse(readFileSync(join(resultsDir, file), "utf8")).results[0];
			if (result.retainedWorkDir) retained.push(result.retainedWorkDir);
			assert.equal(result.toolCalls, 1);
			assert.equal(result.tokens, 42);
			assert.equal(result.humanInterventions, 0);
			assert.equal(result.agentExit, code);
			assert.equal(result.pass, code === 0);
			assert.ok(readdirSync(resultsDir).some((name) => name.endsWith(".events.jsonl")));
		}
	} finally {
		for (const work of retained) rmSync(work, { recursive: true, force: true });
		rmSync(temp, { recursive: true, force: true });
	}
});
