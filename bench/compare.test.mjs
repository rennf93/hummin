import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compare, toBaseline } from "./compare.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const good = [{ fixture: "a", pass: true, toolCalls: 3, toolErrors: 0, durationSec: 4 }];
const baseline = toBaseline(good);

test("identical results pass; wall time never fails", () => {
	assert.deepEqual(compare([{ ...good[0], durationSec: 400 }], baseline).failures, []);
});

test("pass drop, tool errors, call count change and missing fixture all fail", () => {
	for (const worse of [{ pass: false }, { toolErrors: 1 }, { toolCalls: 4 }, { toolCalls: 2 }]) {
		assert.equal(compare([{ ...good[0], ...worse }], baseline).failures.length, 1, JSON.stringify(worse));
	}
	assert.throws(() => compare([], baseline), /no fixtures/);
});

test("fixture absent from baseline fails", () => {
	const extra = [...good, { ...good[0], fixture: "new" }];
	assert.deepEqual(compare(extra, baseline).failures, ["new: not in baseline, run --update to add it"]);
});

test("cli exits 1 with one line on malformed results and an empty directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "hummin-compare-test-"));
	try {
		const malformed = join(dir, "bad.json");
		writeFileSync(malformed, "{}");
		const empty = join(dir, "empty");
		mkdirSync(empty);
		for (const target of [malformed, empty]) {
			const run = spawnSync(process.execPath, [join(directory, "compare.mjs"), target], { encoding: "utf8" });
			assert.equal(run.status, 1, run.stderr);
			assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
			assert.match(run.stderr, /^FAIL: /);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
