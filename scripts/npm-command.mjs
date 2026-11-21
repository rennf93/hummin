import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// npm exports its own config to children as npm_config_* env vars, so a user-level
// `allow-scripts` entry lands at CLI/env priority and npm 11+ rejects it in the
// project-scoped installs our scripts run (EALLOWSCRIPTS). All call sites pass
// --ignore-scripts or run no lifecycle scripts, so the allowlist is irrelevant here.
function childEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("npm_config_")) delete env[key];
	}
	return env;
}

export function execNpmSync(args, options = {}) {
	if (process.platform !== "win32") return execFileSync("npm", args, { ...options, env: childEnv() });
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Cannot locate npm on Windows. Run this command through its npm script.");
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	return execFileSync(process.execPath, [npmCli, ...args], { ...options, env: childEnv() });
}
