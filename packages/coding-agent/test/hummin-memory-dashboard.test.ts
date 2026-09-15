import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { getMemoryDashboard, writeQuickCapture } from "../extensions/hummin-memory.ts";

let vault = "";
let originalVault: string | undefined;
let originalMemory: string | undefined;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "hummin-memory-dashboard-"));
	originalVault = process.env.HUMMIN_MEMORY_VAULT_DIR;
	originalMemory = process.env.HUMMIN_MEMORY;
	process.env.HUMMIN_MEMORY_VAULT_DIR = vault;
	process.env.HUMMIN_MEMORY = "1";
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	if (originalVault === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
	else process.env.HUMMIN_MEMORY_VAULT_DIR = originalVault;
	if (originalMemory === undefined) delete process.env.HUMMIN_MEMORY;
	else process.env.HUMMIN_MEMORY = originalMemory;
});

test("quick capture writes escaped frontmatter and avoids timestamp collisions", () => {
	const now = new Date("2026-09-15T12:34:56.789Z");
	const first = writeQuickCapture(vault, '/tmp/project "one"', "remember this", now);
	const second = writeQuickCapture(vault, "/tmp/project", "another", now);
	expect(first).toMatch(/note-2026-09-15T12-34-56-789Z\.md$/);
	expect(second).toMatch(/note-2026-09-15T12-34-56-789Z-1\.md$/);
	expect(readFileSync(first, "utf8")).toContain('project: "/tmp/project \\"one\\""');
});

test("dashboard counts entity types, inbox, processed, and latest fold log entries", () => {
	for (const type of ["project", "concept", "decision", "gotcha", "tool", "person"]) {
		mkdirSync(join(vault, "entities", type), { recursive: true });
	}
	writeFileSync(join(vault, "entities", "project", "hummin.md"), "# Hummin");
	writeFileSync(join(vault, "entities", "gotcha", "one.md"), "# One");
	mkdirSync(join(vault, "inbox"));
	mkdirSync(join(vault, "processed"));
	writeFileSync(join(vault, "inbox", "note.md"), "note");
	writeFileSync(join(vault, "processed", "lesson.md"), "lesson");
	writeFileSync(join(vault, "log.md"), "# Fold log\n- one\n- two\n- three\n- four\n");
	const dashboard = getMemoryDashboard();
	expect(dashboard.enabled).toBe(true);
	expect(dashboard.entities.project).toBe(1);
	expect(dashboard.entities.gotcha).toBe(1);
	expect(dashboard.inbox).toBe(1);
	expect(dashboard.processed).toBe(1);
	expect(dashboard.log).toEqual(["- four", "- three", "- two"]);
});
