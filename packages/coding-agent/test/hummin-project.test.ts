import { describe, expect, it } from "vitest";
import projectExtension from "../extensions/hummin-project.ts";

describe("hummin project extension", () => {
	it("registers init and doctor commands", () => {
		const names: string[] = [];
		projectExtension({ registerCommand: (name: string) => names.push(name) } as never);
		expect(names).toEqual(["init", "doctor"]);
	});
});
