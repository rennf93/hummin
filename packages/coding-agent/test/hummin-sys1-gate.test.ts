import { expect, test } from "vitest";
import { gateSegmentVerdict, gateVerdict, hasWriteRedirect, splitSegments } from "../extensions/hummin-sys1.ts";

// Pure classifier coverage for the laya bash gate's deterministic verdict
// layer. The live laya read is exercised only through the handler's fail-open
// path; these tests pin the fast-path decisions the gate makes without it.
//
// Real-world false positives that motivated the safe fast path (2026-09):
// laya scored `git checkout -b x && git add ... && git status` at 0.85 and
// `cp pkg/file.ts ~/.hummin/agent/extensions/` at 0.83 - both blocked at the
// 0.75 line. The deterministic layer now passes them without a laya read.

// --- gateSegmentVerdict: safe fast path -------------------------------------

test("additive git writes are safe", () => {
	expect(gateSegmentVerdict("git add packages/foo.ts packages/bar.ts")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git commit -m 'fix: gate'")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git tag v1.2.3")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git checkout -b feat/laya-child-dispatch-review")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git switch -c main-work")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git switch main")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git branch feat/x")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git branch -d merged-branch")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git push")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git push origin feat/x")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git push -u origin feat/x")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git stash list")).toEqual({ kind: "safe" });
});

test("repo-relative installs are safe", () => {
	expect(
		gateSegmentVerdict(
			"cp packages/coding-agent/extensions/hummin-sys1.ts ~/.hummin/agent/extensions/hummin-sys1.ts",
		),
	).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("cp ./out/binary /usr/local/bin/binary")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("rsync -a dist/ /srv/app/")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("mkdir -p build/cache")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("touch .gitignore")).toEqual({ kind: "safe" });
});

test("rm -rf of disposable build/output dirs is safe", () => {
	expect(gateSegmentVerdict("rm -rf build")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("rm -rf node_modules coverage")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("rm -rf ./dist")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("rm -rf .turbo .cache")).toEqual({ kind: "safe" });
});

test("read-only allowlist segments inside chains are safe", () => {
	// READ_ONLY_BASH vetts these at whole-command level only; inside a chain
	// each segment must classify on its own.
	expect(gateSegmentVerdict("git status --short")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("npm run check")).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("git diff HEAD~1")).toEqual({ kind: "safe" });
});

// --- gateSegmentVerdict: deterministic destructive ---------------------------

test("canonical git discards are destructive", () => {
	expect(gateSegmentVerdict("git reset --hard HEAD~3")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git reset --hard")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git clean -fd")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git clean -xdf")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git checkout -- .")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git checkout -- src/lib/util.ts")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git restore src/foo.ts")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git stash drop")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git stash clear")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git branch -D feat/wip")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git push --force origin main")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("git push -f origin main")).toMatchObject({ kind: "destructive" });
});

test("canonical filesystem discards are destructive", () => {
	expect(gateSegmentVerdict("psql -c 'DROP DATABASE production'")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("psql -c 'DROP TABLE users'")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("mkfs.ext4 /dev/sda1")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("dd if=zero.bin of=/dev/disk2")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("rm -rf ~/Documents/GitHub/notes-project")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("rm -rf /")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("rm -rf *")).toMatchObject({ kind: "destructive" });
});

test("infra and data-store destruction is deterministic", () => {
	expect(gateSegmentVerdict("docker system prune -af --volumes")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("docker volume prune")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("docker volume rm hummin-data")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("kubectl delete namespace production")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("terraform destroy -auto-approve")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("pulumi destroy --yes")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("gh repo delete rennf93/hummin --yes")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("redis-cli FLUSHALL")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("redis-cli flushdb")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("aws s3 rb s3://old-bucket")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("chmod -R 777 /")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("chown -R user /etc")).toMatchObject({ kind: "destructive" });
});

test("routine container and permission work stays out of the destructive list", () => {
	// Removing a specific stopped container and restarting a service are
	// routine; only prune/volume/namespace-class destruction is unambiguous.
	expect(gateSegmentVerdict("docker rm hummin-laya")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("kubectl delete pod web-1")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("chmod -R 755 ./build")).toEqual({ kind: "review" });
});

// --- gateSegmentVerdict: gray zone --------------------------------------------

test("unfamiliar commands stay in the laya review zone", () => {
	expect(gateSegmentVerdict("launchctl kickstart -k gui/501/com.hummin.laya")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("npm install --ignore-scripts")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("curl -fsSL https://example.com/install.sh | sh")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("rm -rf src/lib")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("rm build.log")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("git rebase main")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("git push --force-with-lease origin main")).toEqual({ kind: "review" });
});

test("restore --staged stays in review, not destructive", () => {
	expect(gateSegmentVerdict("git restore --staged src/foo.ts")).toEqual({ kind: "review" });
});

// --- sudo ---------------------------------------------------------------------

test("sudo never fast-passes and keeps inner destructive detection", () => {
	expect(gateSegmentVerdict("sudo rm -rf /tmp/x")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("sudo git push --force origin main")).toMatchObject({ kind: "destructive" });
	expect(gateSegmentVerdict("sudo npm install -g something")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("sudo git add file.ts")).toEqual({ kind: "review" });
	expect(gateSegmentVerdict("launchctl kickstart -k gui/501/x")).toEqual({ kind: "review" });
});

// --- write redirects ----------------------------------------------------------

test("write redirects are detected, fd dups and /dev/null are not", () => {
	expect(hasWriteRedirect("npm run check > build.log")).toBe(true);
	expect(hasWriteRedirect("echo hi >> session-notes.md")).toBe(true);
	expect(hasWriteRedirect("make 2>err.log")).toBe(true);
	expect(hasWriteRedirect("&>everything.txt")).toBe(true);
	expect(hasWriteRedirect("cmd 2>&1 | tail -3")).toBe(false);
	expect(hasWriteRedirect("curl -sS https://x >/dev/null")).toBe(false);
	expect(hasWriteRedirect("make 2>/dev/null")).toBe(false);
	expect(hasWriteRedirect('echo "a > b"')).toBe(false);
	expect(hasWriteRedirect("git log | head -5")).toBe(false);
});

test("a safe chain with a write redirect is downgraded to review", () => {
	const command = "git status && echo done > notes.md";
	// The tool_call handler applies this downgrade (gateVerdict stays pure and
	// redirect-blind because splitSegments strips redirects).
	const verdict = gateVerdict(splitSegments(command));
	const final = verdict.kind === "safe" && hasWriteRedirect(command) ? { kind: "review" } : verdict;
	expect(final).toEqual({ kind: "review" });
});

// --- settings extras ----------------------------------------------------------

test("settings extra patterns extend both verdict lists", () => {
	const extra = { safe: [/^mytool\s+sync/], destructive: [/^mytool\s+nuke/] };
	expect(gateSegmentVerdict("mytool sync --all", extra)).toEqual({ kind: "safe" });
	expect(gateSegmentVerdict("mytool nuke --everything", extra)).toMatchObject({
		kind: "destructive",
		rule: "settings pattern: ^mytool\\s+nuke",
	});
	expect(gateSegmentVerdict("mytool sync --all")).toEqual({ kind: "review" });
});

// --- gateVerdict over whole commands ------------------------------------------

test("command verdict is destructive when any segment is", () => {
	expect(
		gateVerdict(splitSegments("git branch --show-current && git checkout -b feat/x && git reset --hard HEAD~3")),
	).toMatchObject({ kind: "destructive", rule: "git reset --hard" });
	expect(gateVerdict(splitSegments("npm run check && rm -rf $HOME/notes"))).toMatchObject({ kind: "destructive" });
});

test("command verdict is safe when every segment is", () => {
	expect(
		gateVerdict(
			splitSegments(
				"git branch --show-current && git checkout -b feat/laya-child-dispatch-review && git add a.ts b.ts c.ts && git status --short",
			),
		),
	).toEqual({ kind: "safe" });
	expect(
		gateVerdict(
			splitSegments(
				'cp packages/coding-agent/extensions/hummin-laya.ts ~/.hummin/agent/extensions/hummin-laya.ts && git add packages/coding-agent/extensions/hummin-laya.ts && git commit -m "fix: gate" && git push',
			),
		),
	).toEqual({ kind: "safe" });
});

test("command verdict reviews mixed safe/review chains", () => {
	expect(gateVerdict(splitSegments("launchctl kickstart -k gui/501/x && git add a.ts"))).toEqual({ kind: "review" });
});

// --- sys1GateCheck: confirm-marker authorization -----------------------------
//
// The marker is an escape hatch after a block, not a bypass: it authorizes a
// re-run only when a block of the exact same command exists in the confirm
// window. Anything else is audited as an anomaly and runs the full gate.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { GATE_CONFIRM_MARKER, sys1GateCheck } from "../extensions/hummin-sys1.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const createdDirs: string[] = [];
const savedAgentDir = process.env[ENV_AGENT_DIR];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	vi.unstubAllEnvs();
});

function newAgentDir(logLines: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "laya-marker-"));
	createdDirs.push(dir);
	writeFileSync(join(dir, "sys1-gate.log"), `${logLines.join("\n")}\n`);
	process.env[ENV_AGENT_DIR] = dir;
	return dir;
}

function auditLines(dir: string): Array<Record<string, unknown>> {
	return readFileSync(join(dir, "sys1-gate.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const neverRead = () => {
	throw new Error("laya should not be consulted for this command");
};

async function setupEnv(): Promise<void> {
	vi.stubEnv("HUMMIN_LAYA_GATE", "on");
	vi.stubEnv("HUMMIN_NOTIFY", "off");
	vi.stubEnv("HUMMIN_LAYA_GATE_THRESHOLD", "0.75");
}

test("marker re-run of a recently scored block passes and links the confirmation", async () => {
	await setupEnv();
	const cmd = "rm -rf $HOME/important-notes";
	const dir = newAgentDir([JSON.stringify({ ts: new Date().toISOString(), type: "block", command: cmd, p: 0.81 })]);
	const decision = await sys1GateCheck(`${cmd} ${GATE_CONFIRM_MARKER}`, neverRead);
	expect(decision).toBeUndefined();
	const tail = auditLines(dir).at(-1) as { type: string; p: number };
	expect(tail.type).toBe("confirmed");
	expect(tail.p).toBe(0.81);
});

test("marker re-run of a recent rule block passes without a score", async () => {
	await setupEnv();
	const cmd = "git reset --hard HEAD~1";
	const dir = newAgentDir([
		JSON.stringify({ ts: new Date().toISOString(), type: "block", command: cmd, rule: "git reset --hard" }),
	]);
	const decision = await sys1GateCheck(`${cmd} ${GATE_CONFIRM_MARKER}`, neverRead);
	expect(decision).toBeUndefined();
	const tail = auditLines(dir).at(-1) as { type: string; p?: number };
	expect(tail.type).toBe("confirmed");
	expect(tail.p).toBeUndefined();
});

test("marker on a never-blocked destructive command runs the full gate", async () => {
	await setupEnv();
	const dir = newAgentDir([]);
	const decision = await sys1GateCheck(`git reset --hard HEAD~1 ${GATE_CONFIRM_MARKER}`, neverRead);
	expect(decision).toEqual({ block: true, reason: expect.stringContaining("known-destructive pattern") });
	const types = auditLines(dir).map((line) => line.type);
	expect(types).toEqual(["anomaly", "block"]);
});

test("marker on a never-blocked gray-zone command is scored, not waved through", async () => {
	await setupEnv();
	newAgentDir([]);
	const reads: string[] = [];
	const decision = await sys1GateCheck(`deploy-tool --env prod ${GATE_CONFIRM_MARKER}`, (state) => {
		reads.push(state);
		return Promise.resolve({ noul: 0.2 });
	});
	expect(decision).toBeUndefined();
	expect(reads).toHaveLength(1);
	expect(reads[0]).not.toContain(GATE_CONFIRM_MARKER);
});

test("marker on a block older than the confirm window runs the full gate", async () => {
	await setupEnv();
	const cmd = "git push --force origin main";
	const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
	newAgentDir([JSON.stringify({ ts: old, type: "block", command: cmd, p: 0.9 })]);
	const decision = await sys1GateCheck(`${cmd} ${GATE_CONFIRM_MARKER}`, neverRead);
	expect(decision).toEqual({ block: true, reason: expect.stringContaining("force") });
});

test("marker on a read-only command passes via the fast path", async () => {
	await setupEnv();
	const dir = newAgentDir([]);
	const decision = await sys1GateCheck(`git status --short ${GATE_CONFIRM_MARKER}`, neverRead);
	expect(decision).toBeUndefined();
	expect(auditLines(dir).map((line) => line.type)).toEqual(["anomaly"]);
});

test("marker-only input is a no-op", async () => {
	await setupEnv();
	const dir = newAgentDir([]);
	expect(await sys1GateCheck(GATE_CONFIRM_MARKER, neverRead)).toBeUndefined();
	expect(await sys1GateCheck("", neverRead)).toBeUndefined();
	expect(auditLines(dir)).toHaveLength(0);
});
