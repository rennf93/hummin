import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProjectContextFiles, resetContextFileSizeWarnings } from "../src/core/resource-loader.ts";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";

function createTestSkill(name: string, description = `The ${name} skill.`): Skill {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name,
		description,
		filePath,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: false,
	};
}

describe("skills prompt cap (skillsMaxPromptEntries)", () => {
	it("lists every skill in input order when the cap is 0 (default)", () => {
		const skills = [createTestSkill("zeta"), createTestSkill("alpha"), createTestSkill("mid")];

		const result = formatSkillsForPrompt(skills);

		expect(result).toContain("<name>zeta</name>");
		expect(result).toContain("<name>alpha</name>");
		expect(result).toContain("<name>mid</name>");
		expect(result).not.toContain("more skills available on disk");
		// Input order is preserved, not re-sorted.
		expect(result.indexOf("<name>zeta</name>")).toBeLessThan(result.indexOf("<name>alpha</name>"));
	});

	it("keeps the first cap entries alphabetically and appends the more-line", () => {
		const skills = [
			createTestSkill("d-region"),
			createTestSkill("b-region"),
			createTestSkill("c-region"),
			createTestSkill("a-region"),
		];

		const result = formatSkillsForPrompt(skills, "read", { maxEntries: 2 });

		expect(result).toContain("<name>a-region</name>");
		expect(result).toContain("<name>b-region</name>");
		expect(result).not.toContain("<name>c-region</name>");
		expect(result).not.toContain("<name>d-region</name>");
		expect((result.match(/<skill>/g) || []).length).toBe(2);
		expect(result.trimEnd().endsWith("+ 2 more skills available on disk (see the skills directories)")).toBe(true);
	});

	it("cuts deterministically regardless of input order", () => {
		const first = formatSkillsForPrompt(
			[createTestSkill("delta"), createTestSkill("charlie"), createTestSkill("bravo"), createTestSkill("alpha")],
			"read",
			{ maxEntries: 1 },
		);
		const second = formatSkillsForPrompt(
			[createTestSkill("alpha"), createTestSkill("bravo"), createTestSkill("charlie"), createTestSkill("delta")],
			"read",
			{ maxEntries: 1 },
		);

		expect(first).toBe(second);
		expect(first).toContain("<name>alpha</name>");
		expect(first.trimEnd().endsWith("+ 3 more skills available on disk (see the skills directories)")).toBe(true);
	});

	it("does not append a more-line when the list fits the cap", () => {
		const skills = [createTestSkill("b-skill"), createTestSkill("a-skill")];

		const result = formatSkillsForPrompt(skills, "read", { maxEntries: 2 });

		expect(result).toContain("<name>a-skill</name>");
		expect(result).toContain("<name>b-skill</name>");
		expect(result).not.toContain("more skills available on disk");
	});

	it("excludes hidden skills before applying the cap", () => {
		const visible = createTestSkill("only-visible");
		const hidden: Skill = { ...createTestSkill("z-hidden"), disableModelInvocation: true };

		const result = formatSkillsForPrompt([visible, hidden], "read", { maxEntries: 1 });

		expect(result).toContain("<name>only-visible</name>");
		expect(result).not.toContain("<name>z-hidden</name>");
		expect(result).not.toContain("more skills available on disk");
	});

	it("threads skillsMaxPromptEntries from build options into the skills section", () => {
		const skills = [createTestSkill("zeta"), createTestSkill("alpha"), createTestSkill("mid")];

		const sections = buildSystemPromptSections({
			cwd: "/tmp/project",
			skills,
			selectedTools: ["read"],
			skillsMaxPromptEntries: 1,
		});

		const skillsSection = sections.skills ?? "";
		expect(skillsSection).toContain("<name>alpha</name>");
		expect(skillsSection).not.toContain("<name>zeta</name>");
		expect(skillsSection).toContain("+ 2 more skills available on disk (see the skills directories)");
	});
});

describe("context-file size cap (contextFileMaxBytes)", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `bloat-levers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		resetContextFileSizeWarnings();
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
		resetContextFileSizeWarnings();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("skips an oversized context file entirely and warns once per file", () => {
		const oversized = "x".repeat(200);
		const agentsPath = join(projectDir, "AGENTS.md");
		writeFileSync(agentsPath, oversized);

		const first = loadProjectContextFiles({ cwd: projectDir, agentDir, contextFileMaxBytes: 100 });
		expect(first.some((file) => file.path === agentsPath)).toBe(false);
		expect(first.some((file) => file.content.includes(oversized))).toBe(false);

		const second = loadProjectContextFiles({ cwd: projectDir, agentDir, contextFileMaxBytes: 100 });
		expect(second.some((file) => file.path === agentsPath)).toBe(false);

		const warnings = consoleError.mock.calls.filter((call: unknown[]) =>
			String(call[0]).includes("[hummin] skipping"),
		);
		expect(warnings).toHaveLength(1);
		expect(String(warnings[0][0])).toContain(`[hummin] skipping ${agentsPath}`);
		expect(String(warnings[0][0])).toContain("(200 bytes > contextFileMaxBytes 100)");

		// A reset starts the session warnings over (test-support hook for the module-level set).
		resetContextFileSizeWarnings();
		loadProjectContextFiles({ cwd: projectDir, agentDir, contextFileMaxBytes: 100 });
		expect(
			consoleError.mock.calls.filter((call: unknown[]) => String(call[0]).includes("[hummin] skipping")),
		).toHaveLength(2);
	});

	it("loads files at or under the cap without warnings", () => {
		const agentsPath = join(projectDir, "AGENTS.md");
		writeFileSync(agentsPath, "small instructions");

		const files = loadProjectContextFiles({ cwd: projectDir, agentDir, contextFileMaxBytes: 100 });

		expect(files.some((file) => file.path === agentsPath && file.content === "small instructions")).toBe(true);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("does not cap when contextFileMaxBytes is 0", () => {
		const agentsPath = join(projectDir, "AGENTS.md");
		writeFileSync(agentsPath, "x".repeat(5000));

		const files = loadProjectContextFiles({ cwd: projectDir, agentDir });

		expect(files.some((file) => file.path === agentsPath)).toBe(true);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("does not fall through to lower-priority candidates when the dir's context file is over the cap", () => {
		// Candidates are priority aliases for the dir's single context file; an oversized
		// winner skips the dir entirely rather than loading a file the override replaces.
		const overridePath = join(projectDir, "AGENTS.override.md");
		const agentsPath = join(projectDir, "AGENTS.md");
		writeFileSync(overridePath, "x".repeat(200));
		writeFileSync(agentsPath, "fallback instructions");

		const files = loadProjectContextFiles({ cwd: projectDir, agentDir, contextFileMaxBytes: 100 });

		expect(files.some((file) => file.path === overridePath)).toBe(false);
		expect(files.some((file) => file.path === agentsPath)).toBe(false);
		expect(
			consoleError.mock.calls.filter((call: unknown[]) => String(call[0]).includes("[hummin] skipping")),
		).toHaveLength(1);
	});
});
