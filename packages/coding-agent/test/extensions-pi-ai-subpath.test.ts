import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";

// Regression: pi-ai api/* subpath imports must resolve for extensions in every
// runtime mode. Source mode uses tsconfig paths; bundled runtimes use the
// virtualModules map, which serves api/* from the compat namespace.
describe("extension pi-ai api subpath imports", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function writeExtension(code: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ai-subpath-test-"));
		tempDirs.push(dir);
		const file = path.join(dir, "subpath-ext.ts");
		fs.writeFileSync(file, code);
		return file;
	}

	it("resolves a lazy api entrypoint and exposes its export", async () => {
		const extensionPath = writeExtension(`
			import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
			export default function(pi) {
				if (typeof openAICompletionsApi !== "function") {
					throw new Error("openAICompletionsApi did not resolve to a function");
				}
				pi.registerCommand("subpath-probe", { description: "probe", handler: async () => {} });
			}
		`);
		const result = await loadExtensions([extensionPath], process.cwd());
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has("subpath-probe")).toBe(true);
	});

	it("gives a clear error for symbols a subpath does not export", async () => {
		const extensionPath = writeExtension(`
			import { nope } from "@earendil-works/pi-ai/api/openai-completions.lazy";
			export default function(pi) {
				pi.registerCommand("subpath-probe-2", {
					description: "probe",
					handler: async () => typeof nope,
				});
			}
		`);
		const result = await loadExtensions([extensionPath], process.cwd());
		expect(result.errors).toEqual([]);
		const command = result.extensions[0]?.commands.get("subpath-probe-2");
		expect(command).toBeDefined();
		await expect(command?.handler("", { ui: { notify: () => {} } } as never)).rejects.toThrow(
			'"nope" is not exported by @earendil-works/pi-ai api modules',
		);
	});
});
