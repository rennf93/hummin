import { describe, expect, it } from "vitest";
import fleetExtension, {
	DEFAULT_FLEET,
	fleetSettingsToServers,
	PROMPT_SECTION_WARN_TOKENS,
	PROMPT_TOTAL_WARN_TOKENS,
	probeFleet,
	promptSectionLines,
} from "../extensions/hummin-fleet.ts";

describe("hummin fleet extension", () => {
	it("keeps private fleet configuration empty by default", () => expect(DEFAULT_FLEET).toEqual([]));
	it("does not probe an unconfigured fleet", async () =>
		expect(await probeFleet([], { cwd: "/tmp" } as never)).toEqual(new Map()));
	it("registers fleet and status commands", () => {
		const names: string[] = [];
		fleetExtension({ registerCommand: (name: string) => names.push(name) } as never);
		expect(names).toEqual(["fleet", "status"]);
	});

	it("renders all configured fleet rows with generic host labels", () => {
		const servers = fleetSettingsToServers(
			Array.from({ length: 8 }, (_, index) => ({
				id: `s${index}`,
				label: `Model ${index}`,
				host: `host-${index}`,
				hostIp: `10.0.0.${index + 1}`,
				port: 9000 + index,
				kind: "docker" as const,
				target: `container-${index}`,
			})),
		);
		expect(servers).toHaveLength(8);
		expect(servers[0].hostLabel).toBe("host-0");
	});

	it("uses an empty configured fleet without probing", async () => {
		const ctx = { cwd: "/tmp" } as never;
		expect(await probeFleet([], ctx)).toEqual(new Map());
	});
});

describe("status prompt section estimates", () => {
	it("lists one line per section plus the total", () => {
		const lines = promptSectionLines({ cwd: "/tmp", sections: { alpha: "content" } });

		expect(lines[0]).toBe("prompt sections (est. tokens):");
		expect(lines).toContain("  alpha: 6"); // "<alpha>\ncontent\n</alpha>" is 24 chars
		expect(lines.at(-1)).toMatch(/^ {2}total: ~\d[\d,]*$/);
		expect(lines.filter((line) => line.startsWith("warning:"))).toEqual([]);
	});

	it("warns and names a section over the per-section token budget", () => {
		const lines = promptSectionLines({
			cwd: "/tmp",
			sections: { alpha: "x".repeat(PROMPT_SECTION_WARN_TOKENS * 4 + 1) },
		});
		const warnings = lines.filter((line) => line.startsWith("warning:"));

		expect(warnings).toEqual([
			`warning: prompt section alpha over ${PROMPT_SECTION_WARN_TOKENS.toLocaleString()} tokens (~4,005)`,
		]);
	});

	it("warns when the prompt total exceeds the total budget", () => {
		const lines = promptSectionLines({
			cwd: "/tmp",
			sections: { alpha: "x".repeat(PROMPT_TOTAL_WARN_TOKENS * 4 + 1) },
		});
		const warnings = lines.filter((line) => line.startsWith("warning:"));

		expect(
			warnings.some((line) =>
				line.includes(`prompt total over ${PROMPT_TOTAL_WARN_TOKENS.toLocaleString()} tokens`),
			),
		).toBe(true);
		expect(warnings.some((line) => line.includes("prompt section alpha over"))).toBe(true);
	});

	it("reports a forced prompt as a single unsectioned line", () => {
		expect(promptSectionLines({ cwd: "/tmp", forceSystemPrompt: "abcd" })).toEqual([
			"prompt: forced, ~1 tokens (est.), sections not shown",
		]);
	});
});
