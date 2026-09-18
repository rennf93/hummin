#!/usr/bin/env node
/**
 * Extension load smoke: every bundled extension must factory-load cleanly
 * against a mock ExtensionAPI in an isolated agent dir. Catches module-scope
 * crashes (e.g. bind races, missing exports) that type checks cannot see.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = join(root, "packages", "coding-agent", "extensions");
const agentDir = mkdtempSync(join(tmpdir(), "hummin-ext-smoke-"));

const files = [];
for (const dirent of await import("node:fs").then((m) => m.readdirSync(extDir, { withFileTypes: true }))) {
	if (dirent.isFile() && dirent.name.endsWith(".ts")) files.push(join(extDir, dirent.name));
}
files.sort();

const wrapper = join(agentDir, "load-one.mjs");
await import("node:fs").then((m) => m.writeFileSync(
	wrapper,
	`const mod = await import(process.argv[2]);
	const factory = mod.default ?? mod;
	if (typeof factory !== "function") throw new Error("no default factory export");
	const handler = () => undefined;
	const pi = new Proxy({}, { get: (_t, prop) => (prop === "__esModule" ? false : handler) });
	await factory(pi);
	console.log("loaded");
`,
));

const tsx = join(root, "node_modules", ".bin", "tsx");
const env = {
	...process.env,
	HUMMIN_CODING_AGENT_DIR: agentDir,
	PI_CODING_AGENT_DIR: agentDir,
	HUMMIN_MEMORY: "0",
	HUMMIN_AGENTS: "0",
	HUMMIN_CRON: "0",
	HUMMIN_SANDBOX: "0",
	HUMMIN_GUARDRAILS: "0",
	HUMMIN_LSP: "0",
	HUMMIN_MCP: "0",
	HUMMIN_BASHGUARD: "0",
};

let failures = 0;
for (const file of files) {
	const name = basename(file);
	const res = spawnSync(tsx, ["--tsconfig", join(root, "tsconfig.json"), wrapper, file], {
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	const ok = res.status === 0 && out.includes("loaded") && !out.includes("Extension error");
	if (!ok) {
		failures += 1;
		console.log(`FAIL ${name}\n${out.slice(-1200)}`);
	} else {
		console.log(`ok   ${name}`);
	}
}

rmSync(agentDir, { recursive: true, force: true });
console.log(`${files.length - failures}/${files.length} extensions loaded`);
process.exit(failures > 0 ? 1 : 0);
