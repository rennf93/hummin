import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type BashguardConfig, DEFAULT_BASHGUARD_CONFIG } from "../extensions/hummin-bashguard.ts";
import { layaGateCheck } from "../extensions/hummin-laya.ts";
import { PLAN_BLOCKED_TOOLS } from "../extensions/hummin-plan.ts";
import { gateBackgroundShell } from "../extensions/lib/shell-gate.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

// The shared shell gate: exec and monitor spawn through ProcessManager, so
// their commands must pass the same laya-gate and bashguard classification
// the bash tool gets. These tests pin the deterministic decisions without any
// network: the laya read is injected everywhere.

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** A laya read that must never be reached (deterministic paths only). */
const unreachable = (): Promise<{ noul: number } | null> => {
	throw new Error("laya read must not run for deterministic commands");
};

/** A real layaGateCheck with the network read injected: deterministic rules
 * and the read-only fast path stay live in tests, only laya is faked. */
function gated(cwd: string, read: () => Promise<{ noul: number } | null>) {
	return (command: string) => layaGateCheck(command, read, cwd);
}

/** Hermetic settings: an empty agent dir so global layaGate extras cannot leak in. */
function isolatedCwd(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "hummin-shell-gate-"));
	cleanups.push(agentDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	const cwd = join(agentDir, "project");
	mkdirSync(cwd, { recursive: true });
	return cwd;
}

const readOnlyConfig = (over: Partial<BashguardConfig> = {}): BashguardConfig => ({
	...DEFAULT_BASHGUARD_CONFIG,
	...over,
});

test("plan mode blocks exec and cron scheduling alongside the other shell paths", () => {
	for (const tool of ["edit", "write", "bash", "powershell", "task", "monitor", "exec", "cron_create"]) {
		expect(PLAN_BLOCKED_TOOLS.has(tool)).toBe(true);
	}
});

test("layaGateCheck blocks canonical destructive commands without a laya read", async () => {
	isolatedCwd();
	const decision = await layaGateCheck("git reset --hard", unreachable);
	expect(decision).toMatchObject({ block: true });
	expect(decision?.reason).toContain("known-destructive pattern (git reset --hard)");
	await expect(layaGateCheck("rm -rf /tmp/build", unreachable)).resolves.toMatchObject({ block: true });
	// +refspec is force-push syntax even without --force.
	await expect(layaGateCheck("git push origin +main", unreachable)).resolves.toMatchObject({ block: true });
	// Plain pushes stay safe.
	await expect(layaGateCheck("git push origin feat/x", unreachable)).resolves.toBeUndefined();
});

test("layaGateCheck lets the confirm marker through and audits nothing on plain rerun", async () => {
	const cwd = isolatedCwd();
	await expect(layaGateCheck("git reset --hard", unreachable)).resolves.toMatchObject({ block: true });
	const confirmed = await layaGateCheck("git reset --hard # laya-gate: confirmed", unreachable, cwd);
	expect(confirmed).toBeUndefined();
	// The bare command (marker stripped) clears the repeat latch.
	const afterConfirm = await layaGateCheck("git reset --hard", unreachable, cwd);
	expect(afterConfirm).toMatchObject({ block: true });
	expect(afterConfirm?.reason).not.toContain("already blocked once");
});

test("layaGateCheck passes read-only commands and scores the gray zone", async () => {
	const cwd = isolatedCwd();
	await expect(layaGateCheck("ls src && cat package.json", unreachable, cwd)).resolves.toBeUndefined();
	// A safe command with a write redirect is downgraded to the gray zone: the
	// redirect hides from segment classification, so laya must see it.
	const high = async (): Promise<{ noul: number } | null> => ({ noul: 0.9 });
	const low = async (): Promise<{ noul: number } | null> => ({ noul: 0.1 });
	const blocked = await layaGateCheck("git add file > log.txt", high, cwd);
	expect(blocked).toMatchObject({ block: true });
	expect(blocked?.reason).toContain("P=0.90");
	await expect(layaGateCheck("git add file > log.txt", low, cwd)).resolves.toBeUndefined();
	// A non-read-only segment reaches laya without the redirect downgrade.
	await expect(layaGateCheck("node build.js > out.log", high, cwd)).resolves.toMatchObject({ block: true });
});

test("gateBackgroundShell propagates bashguard blocks, advisories, and laya blocks", async () => {
	const cwd = isolatedCwd();
	// bashguard block config wins before laya is consulted.
	const blocked = await gateBackgroundShell("git reset --hard", cwd, {
		bashguardConfig: readOnlyConfig({ block: true }),
		layaCheck: gated(cwd, unreachable),
	});
	expect(blocked.blocked).toContain("[BashGuard]");
	expect(blocked.advisory).toBeUndefined();
	// advisory-only command runs, carrying the notice.
	const advised = await gateBackgroundShell("sed -i 's/a/b/' ../outside.txt", cwd, {
		bashguardConfig: readOnlyConfig(),
		layaCheck: gated(cwd, async () => ({ noul: 0.1 })),
	});
	expect(advised.blocked).toBeUndefined();
	expect(advised.advisory).toContain("sed -i");
	// laya block reason passes through verbatim.
	const layaBlocked = await gateBackgroundShell("echo update > important.txt", cwd, {
		bashguardConfig: readOnlyConfig(),
		layaCheck: async () => ({ block: true, reason: "[laya gate] scored destructive" }),
	});
	expect(layaBlocked.blocked).toBe("[laya gate] scored destructive");
	// read-only background command: no block, no advisory, no laya read.
	const clean = await gateBackgroundShell("sleep 2 && gh run view 1", cwd, {
		bashguardConfig: readOnlyConfig(),
		layaCheck: gated(cwd, unreachable),
	});
	expect(clean.blocked).toBeUndefined();
	expect(clean.advisory).toBeUndefined();
});

test("gateBackgroundShell sends escape-shaped gray-zone execs to laya and blocks", async () => {
	const cwd = isolatedCwd();
	const decision = await gateBackgroundShell("exec 'rm' '-rf' '~/.ssh'", cwd, {
		bashguardConfig: readOnlyConfig(),
		layaCheck: (command) =>
			layaGateCheck(
				command,
				(state) => {
					// The gray zone reaches laya with the command text intact.
					expect(state).toContain("rm");
					return Promise.resolve({ noul: 0.9 });
				},
				cwd,
			),
	});
	expect(decision.blocked).toContain("[sys1 gate]");
	expect(decision.blocked).toContain("P=0.90");
});

test("gateBackgroundShell honors bashguard readOnly deny for background shells", async () => {
	const cwd = isolatedCwd();
	writeFileSync(join(cwd, "marker.txt"), "x");
	const decision = await gateBackgroundShell("echo hello > marker.txt", cwd, {
		bashguardConfig: readOnlyConfig({ readOnly: true }),
		layaCheck: gated(cwd, unreachable),
	});
	expect(decision.blocked).toContain("read-only mode");
});
