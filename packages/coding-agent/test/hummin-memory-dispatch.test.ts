import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { enqueueDistill, enqueueFold, triggerAutoFold } from "../extensions/hummin-memory.ts";

const dirs: string[] = [];
const originalMemory = process.env.HUMMIN_MEMORY_DIR;
const originalVault = process.env.HUMMIN_MEMORY_VAULT_DIR;
const originalPath = process.env.PATH;

afterEach(() => {
	if (originalMemory === undefined) delete process.env.HUMMIN_MEMORY_DIR;
	else process.env.HUMMIN_MEMORY_DIR = originalMemory;
	if (originalVault === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = originalVault;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function context(action: "allow" | "block") {
	let calls = 0;
	const prompts: string[] = [];
	const messages: string[] = [];
	return {
		modelRegistry: { getAvailable: () => [] },
		dispatch: async (input: { prompt: string }) => {
			calls++;
			prompts.push(input.prompt);
			return {
				action,
				reviewId: "review-memory-1",
				reason: action === "block" ? "held for explicit memory review" : "approved memory review",
				configuration: { provider: "zai", modelId: "glm-5.3-flash", thinking: "low" as const },
				receipt: {
					reviewId: "review-memory-1",
					fingerprint: "fp",
					kind: "memory-fold" as const,
					prompt: "memory",
					cwd: "/tmp",
					configuration: { provider: "zai", modelId: "glm-5.3-flash", thinking: "low" as const },
				},
			};
		},
		calls: () => calls,
		prompts,
		messages,
		ui: { notify: (message: string) => messages.push(message) },
	};
}

test("distillation holds pending input without spawning, then uses approved tuple", async () => {
	const memory = tempDir("hummin-memory-dispatch-");
	process.env.HUMMIN_MEMORY_DIR = memory;
	const session = join(memory, "session.jsonl");
	writeFileSync(
		session,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(180) }] } })}\n`,
	);
	const held = context("block");
	await enqueueDistill(session, "/tmp/project", false, { ...held, agentDir: tempDir("hummin-memory-reviews-") });
	// A held distill writes no pending job file: nothing consumes it later. The
	// hold lives in child-dispatch-reviews.json and the ui notice.
	const pending = join(memory, "pending");
	expect(existsSync(pending)).toBe(false);
	expect(held.messages[0]).toContain("memory distillation held for dispatch review review-memory-1");
	expect(held.calls()).toBe(1);
});

test("explicit fold and automatic fold hold before their child launches", async () => {
	const vault = tempDir("hummin-memory-vault-dispatch-");
	process.env.HUMMIN_MEMORY_DIR = tempDir("hummin-memory-dispatch-");
	process.env.HUMMIN_MEMORY_VAULT_DIR = vault;
	mkdirSync(join(vault, "inbox"), { recursive: true });
	for (const name of ["lesson-a.md", "lesson-b.md", "lesson-c.md"])
		writeFileSync(join(vault, "inbox", name), "lesson\n");
	const held = context("block");
	const ctx = { ...held, agentDir: tempDir("hummin-memory-reviews-") };
	expect(await enqueueFold(vault, "test", ctx)).toBe(false);
	expect(existsSync(join(vault, ".fold-job.json"))).toBe(true);
	const bin = tempDir("hummin-memory-bin-");
	const hummin = join(bin, "hummin");
	const argsFile = join(bin, "args");
	writeFileSync(hummin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho spawned\n`);
	chmodSync(hummin, 0o755);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	expect(await triggerAutoFold(vault, "test", ctx)).toBe(false);
	expect(held.calls()).toBe(2);
	const approved = context("allow");
	expect(await enqueueFold(vault, "approved", { ...approved, agentDir: tempDir("hummin-memory-reviews-") })).toBe(
		true,
	);
	for (let i = 0; i < 20 && !existsSync(join(vault, "fold.log")); i++)
		await new Promise((resolve) => setTimeout(resolve, 25));
	expect(readFileSync(join(vault, "fold.log"), "utf8")).toContain("spawned");
	expect(readFileSync(argsFile, "utf8").split("\n")).toEqual(
		expect.arrayContaining(["--provider", "zai", "--model", "glm-5.3-flash", "--thinking", "low"]),
	);
	expect(approved.calls()).toBe(1);
	const autoApproved = context("allow");
	expect(
		await triggerAutoFold(vault, "auto-approved", { ...autoApproved, agentDir: tempDir("hummin-memory-reviews-") }),
	).toBe(true);
	expect(autoApproved.calls()).toBe(1);
	expect(autoApproved.prompts[0]).toBe(
		"Fold the inbox lessons into the entity graph now, following AGENTS.md exactly.",
	);
});
