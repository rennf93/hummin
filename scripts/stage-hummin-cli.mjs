#!/usr/bin/env node

/**
 * Stages the slim `hummin-cli` npm package from a built coding-agent workspace.
 *
 * The published package is the esbuild bundle plus everything the bundle reads
 * or resolves from disk at runtime:
 *   - dist/bundle                        the application (cli/index/rpc-entry, chunks, lazy impls)
 *   - dist/modes/interactive/theme       built-in themes (dark/light/hummin-dark) + schema
 *   - dist/modes/interactive/assets      bundled interactive assets (mascots, etc.)
 *   - dist/core/export-html              export templates + vendor scripts
 *   - the full upstream dependency set   jiti/typebox are require.resolve'd by the
 *                                        extension loader; @silvia-odwyer/photon-node is
 *                                        an optional runtime import; the @earendil-works/*
 *                                        entries back jiti aliases for extension imports
 *
 * @earendil-works/* ranges are pinned to the upstream-published line because the
 * fork's internal workspace versions are never published to npm.
 *
 * Usage: node scripts/stage-hummin-cli.mjs [--pack]
 * Output: .artifacts/hummin-cli/ (gitignored). --pack also runs `npm pack`.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scriptDir = new URL(".", import.meta.url).pathname;
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const codingAgentDistDir = join(codingAgentDir, "dist");
const stageDir = join(repoRoot, ".artifacts", "hummin-cli");

// Fork-internal workspace versions are not published to npm; extension loading
// and the bundle resolve the published upstream line instead.
const UPSTREAM_RANGE = "^0.85.1";

// Staged relative path -> source relative path inside packages/coding-agent (or repo root when absolute).
const assetTrees = [
	["dist/bundle", join(codingAgentDistDir, "bundle")],
	["dist/modes/interactive/theme", join(codingAgentDistDir, "modes", "interactive", "theme")],
	["dist/modes/interactive/assets", join(codingAgentDistDir, "modes", "interactive", "assets")],
	["dist/core/export-html", join(codingAgentDistDir, "core", "export-html")],
	// The hummin extension set, seeded into the user's agent dir on startup
	// (migrations.seedBundledExtensions). Without it, installs start with no
	// extensions because upstream pi ships none and the agent dir is empty.
	["extensions", join(codingAgentDir, "extensions")],
];

const requiredInputs = [
	join(codingAgentDistDir, "bundle", "cli.js"),
	join(codingAgentDistDir, "bundle", "index.js"),
	join(codingAgentDistDir, "bundle", "rpc-entry.js"),
	join(codingAgentDistDir, "modes", "interactive", "theme", "dark.json"),
	join(codingAgentDistDir, "modes", "interactive", "theme", "light.json"),
	join(codingAgentDistDir, "modes", "interactive", "theme", "hummin-dark.json"),
	join(codingAgentDistDir, "core", "export-html", "template.html"),
];

const requiredStaged = [
	"dist/bundle/cli.js",
	"dist/bundle/index.js",
	"dist/bundle/rpc-entry.js",
	"dist/modes/interactive/theme/dark.json",
	"dist/modes/interactive/theme/light.json",
	"dist/modes/interactive/theme/hummin-dark.json",
	"dist/core/export-html/template.html",
	"extensions/hummin-local.ts",
];

const pack = process.argv.includes("--pack");

const pkg = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
if (!pkg.piConfig?.name || !pkg.piConfig?.configDir) {
	throw new Error("coding-agent manifest is missing piConfig; the published package would fall back to pi branding");
}

for (const input of requiredInputs) {
	if (!existsSync(input)) {
		throw new Error(`Missing bundle input: ${relative(repoRoot, input)}. Run the workspace build first.`);
	}
}

const dependencies = {};
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
	dependencies[name] = name.startsWith("@earendil-works/") ? UPSTREAM_RANGE : range;
}
// Extensions import the extension API by package name; upstream packages ship
// it as the package itself, the slim package needs it as an explicit dep.
dependencies["@earendil-works/pi-coding-agent"] ??= UPSTREAM_RANGE;

const manifest = {
	name: "hummin-cli",
	version: pkg.version,
	description: pkg.description,
	bin: { hummin: "dist/bundle/cli.js" },
	files: ["dist/bundle", "dist/modes", "dist/core", "extensions", "CHANGELOG.md", "LICENSE", "README.md"],
	license: pkg.license,
	repository: pkg.repository,
	engines: pkg.engines,
	keywords: pkg.keywords,
	dependencies,
	piConfig: { ...pkg.piConfig, version: pkg.version },
};

rmSync(stageDir, { force: true, recursive: true });
mkdirSync(stageDir, { recursive: true });

for (const [staged, source] of assetTrees) {
	if (!existsSync(source)) {
		throw new Error(`Missing asset tree: ${relative(repoRoot, source)}. Run the workspace build first.`);
	}
	cpSync(source, join(stageDir, staged), { recursive: true });
}

for (const fileName of ["CHANGELOG.md"]) {
	const source = join(codingAgentDir, fileName);
	if (existsSync(source)) copyFileSync(source, join(stageDir, fileName));
}
// The npm README is the hummin project README from the repo root; the
// coding-agent README is upstream pi's and must not leak onto npm.
copyFileSync(join(repoRoot, "README.md"), join(stageDir, "README.md"));
copyFileSync(join(repoRoot, "LICENSE"), join(stageDir, "LICENSE"));

writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

for (const staged of requiredStaged) {
	if (!existsSync(join(stageDir, staged))) {
		throw new Error(`Staging self-check failed: ${staged} is missing`);
	}
}

console.log(`Staged hummin-cli@${manifest.version} in ${relative(repoRoot, stageDir)}`);
console.log(`  dependencies: ${Object.keys(dependencies).length} packages`);
console.log(`  piConfig.version: ${manifest.piConfig.version}`);
if (pack) {
	spawnSync("npm", ["pack"], { cwd: stageDir, stdio: "inherit" });
}
