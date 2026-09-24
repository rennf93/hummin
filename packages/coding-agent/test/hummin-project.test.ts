import { describe, expect, it } from "vitest";
import projectExtension, { environmentOverridesSection } from "../extensions/hummin-project.ts";

describe("hummin project extension", () => {
	it("registers init and doctor commands", () => {
		const names: string[] = [];
		projectExtension({ registerCommand: (name: string) => names.push(name) } as never);
		expect(names).toEqual(["init", "doctor"]);
	});
});

describe("environmentOverridesSection", () => {
	it("lists set overrides with values and shows secrets as (set) only", () => {
		const lines = environmentOverridesSection({
			HUMMIN_INSTANCES: "http://127.0.0.1:8080",
			HUMMIN_CTX: "128000",
			HUMMIN_LAYA_GATE: "off",
			COLI_API_KEY: "secret-value-do-not-print",
			HUMMIN_MEMORY_VAULT_DIR: "   ",
		});
		expect(lines[0]).toBe("environment overrides:");
		expect(lines).toContain("  HUMMIN_INSTANCES: http://127.0.0.1:8080 (ordered fleet servers)");
		expect(lines).toContain("  HUMMIN_CTX: 128000 (per-model context window fallback)");
		expect(lines).toContain("  HUMMIN_LAYA_GATE: off (laya bash tripwire switch)");
		expect(lines).toContain("  COLI_API_KEY: (set) (laya credential)");
		expect(lines.join("\n")).not.toContain("secret-value-do-not-print");
		// Whitespace-only values count as unset.
		expect(lines.some((line) => line.includes("HUMMIN_MEMORY_VAULT_DIR"))).toBe(false);
	});

	it("shows the header with a none line when nothing overrides settings", () => {
		expect(environmentOverridesSection({})).toEqual(["environment overrides:", "  none"]);
		expect(environmentOverridesSection({ HUMMIN_CTX: "", COLI_API_KEY: undefined })).toEqual([
			"environment overrides:",
			"  none",
		]);
	});
});
