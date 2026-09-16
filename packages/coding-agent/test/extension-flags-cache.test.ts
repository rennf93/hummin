import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExtensionFlagsCache, writeExtensionFlagsCache } from "../src/utils/extension-flags-cache.ts";

describe("extension flags cache", () => {
	let agentDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "flags-cache-"));
		extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "sample.ts"), "export default () => {};\n");
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("roundtrips flags while the extensions dir is unchanged", () => {
		const flags = [{ name: "plan", description: "Plan mode", type: "boolean" as const, extensionPath: "x" }];
		writeExtensionFlagsCache(agentDir, flags);
		expect(readExtensionFlagsCache(agentDir)).toEqual(flags);
	});

	it("returns null when the extensions dir changed after caching", () => {
		writeExtensionFlagsCache(agentDir, []);
		const file = join(extensionsDir, "sample.ts");
		const future = new Date(Date.now() + 60_000);
		utimesSync(file, future, future);
		expect(readExtensionFlagsCache(agentDir)).toBeNull();
	});

	it("returns null when there is no cache file", () => {
		expect(readExtensionFlagsCache(agentDir)).toBeNull();
	});

	it("returns null when the cache is corrupt", () => {
		writeFileSync(join(agentDir, "extension-flags-cache.json"), "{not json");
		expect(readExtensionFlagsCache(agentDir)).toBeNull();
	});
});
