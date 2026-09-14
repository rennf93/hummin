/**
 * hummin init - interactive setup for the features that used to live in
 * shell exports. Writes real settings (global by default, per-project with
 * --project) so `hummin` works without any .zshrc edits. Environment
 * variables (HUMMIN_*) still override stored settings when present.
 */

import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";

type Scope = "global" | "project";

async function ask(rl: readline.Interface, question: string, fallback: string): Promise<string> {
	const suffix = fallback ? chalk.dim(` (${fallback})`) : "";
	const answer = (await rl.question(`${chalk.bold(question)}${suffix}: `)).trim();
	return answer.length > 0 ? answer : fallback;
}

async function askYesNo(rl: readline.Interface, question: string, fallback: boolean): Promise<boolean> {
	const hint = fallback ? "Y/n" : "y/N";
	const answer = (await rl.question(`${chalk.bold(question)} ${chalk.dim(`[${hint}]`)}: `)).trim().toLowerCase();
	if (answer.length === 0) return fallback;
	return answer === "y" || answer === "yes";
}

export function isInitCommand(args: string[]): boolean {
	return args[0] === "init";
}

export async function runInitCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "init") return false;
	const projectFlag = args.includes("--project");
	const yesFlag = args.includes("--yes");
	const readValue = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index !== -1 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.replace(`${name}=`, "");
	};
	const memoryFlag = readValue("--memory");
	const vaultDirFlag = readValue("--vault-dir");
	const instancesFlag = readValue("--instances");
	const consumed = new Set<string>(["init", "--project", "--yes", "--memory", "--vault-dir", "--instances"]);
	[memoryFlag, vaultDirFlag, instancesFlag].forEach((value) => {
		if (value !== undefined) consumed.add(value);
	});
	const rest = args.slice(1).filter((arg) => !consumed.has(arg));
	if (rest.length > 0) {
		console.error(chalk.red(`Unknown arguments for hummin init: ${rest.join(" ")}`));
		console.error(
			chalk.dim(
				"Usage: hummin init [--project] [--yes] [--memory=lesson|vault] [--vault-dir=path] [--instances=url1,url2]",
			),
		);
		process.exitCode = 1;
		return true;
	}

	const scope: Scope = projectFlag ? "project" : "global";
	const settings = SettingsManager.create(process.cwd(), getAgentDir());
	const scopeLabel =
		scope === "global" ? "global (~/.hummin/agent/settings.json)" : "this project (./.hummin/settings.json)";

	console.log(chalk.bold(`\nhummin init - configure ${scopeLabel}\n`));

	// Non-interactive: explicit flags write directly (scriptable setup).
	if (yesFlag || memoryFlag || vaultDirFlag || instancesFlag) {
		const instances = instancesFlag
			? instancesFlag
					.replace("--instances=", "")
					.split(",")
					.map((entry) => entry.trim())
					.filter((entry) => /^https?:\/\//.test(entry))
			: settings.getColibriInstances();
		if (instancesFlag && instances.length === 0) {
			console.error(chalk.red("No valid instances (need http:// or https:// URLs)."));
			process.exitCode = 1;
			return true;
		}
		const memoryEnabled = memoryFlag ? memoryFlag.replace("--memory=", "") !== "off" : settings.getMemoryEnabled();
		const memoryMode = memoryFlag
			? memoryFlag.replace("--memory=", "") === "lesson"
				? "lesson"
				: "vault"
			: settings.getMemoryMode();
		const vaultDir = vaultDirFlag ? vaultDirFlag.replace("--vault-dir=", "") : settings.getMemoryVaultDir();

		settings.setColibriInstances(instances, scope);
		settings.setMemoryEnabled(memoryEnabled, scope);
		settings.setMemoryMode(memoryMode, scope);
		if (memoryMode === "vault") settings.setMemoryVaultDir(vaultDir, scope);
		await settings.flush();

		console.log(chalk.green(`Written to ${scopeLabel}.`));
		console.log(`  local servers:   ${instances.join(", ")}`);
		console.log(`  project memory:  ${memoryEnabled ? "on" : "off"} (${memoryMode})`);
		if (memoryMode === "vault") console.log(`  vault directory: ${vaultDir}`);
		return true;
	}

	const rl = readline.createInterface({ input, output, terminal: input.isTTY ?? false });

	try {
		// 1. Project memory
		console.log(
			chalk.dim(
				"Project memory: sessions distill into lessons; vault mode curates an Obsidian-compatible knowledge graph.",
			),
		);
		const memoryEnabled = await askYesNo(rl, "Enable project memory?", settings.getMemoryEnabled());
		let memoryMode = settings.getMemoryMode();
		let vaultDir = settings.getMemoryVaultDir();
		if (memoryEnabled) {
			const modeAnswer = await ask(rl, "Memory mode (lesson | vault)", memoryMode === "vault" ? "vault" : "lesson");
			memoryMode = modeAnswer === "vault" ? "vault" : "lesson";
			if (memoryMode === "vault") {
				const dirAnswer = await ask(rl, "Vault directory", vaultDir);
				vaultDir = dirAnswer.startsWith("~") ? dirAnswer.replace("~", process.env.HOME ?? "~") : dirAnswer;
			}
		}

		// 2. Local inference fleet (validated)
		console.log("");
		console.log(chalk.dim("Local model servers (OpenAI-compatible endpoints the colibri provider talks to)."));
		let instances = settings.getColibriInstances();
		for (;;) {
			const answer = await ask(rl, "Server base URLs (comma-separated, http(s) only)", instances.join(", "));
			const candidate = answer
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
			const invalid = candidate.filter((url) => !/^https?:\/\//.test(url));
			if (candidate.length > 0 && invalid.length === 0) {
				instances = candidate;
				break;
			}
			if (candidate.length === 0) {
				console.log(chalk.red("  At least one URL is required."));
			} else {
				console.log(chalk.red(`  Not valid URLs (need http:// or https://): ${invalid.join(", ")}`));
			}
		}

		// Summary + confirm
		console.log("");
		console.log(chalk.bold("Summary:"));
		console.log(`  scope:           ${scopeLabel}`);
		console.log(`  local servers:   ${instances.join(", ") || chalk.red("(none)")}`);
		console.log(`  project memory:  ${memoryEnabled ? chalk.green("on") : chalk.red("off")}`);
		if (memoryEnabled) {
			console.log(`  memory mode:     ${memoryMode}`);
			if (memoryMode === "vault") console.log(`  vault directory: ${vaultDir}`);
		}
		console.log("");
		if (!(await askYesNo(rl, "Write these settings?", true))) {
			console.log(chalk.dim("Aborted - nothing written."));
			return true;
		}

		settings.setColibriInstances(instances, scope);
		settings.setMemoryEnabled(memoryEnabled, scope);
		if (memoryEnabled) {
			settings.setMemoryMode(memoryMode, scope);
			if (memoryMode === "vault") settings.setMemoryVaultDir(vaultDir, scope);
		}
		await settings.flush();
		const settingsErrors = settings.drainErrors();
		if (settingsErrors.length > 0) {
			for (const settingsError of settingsErrors) {
				console.error(chalk.red(`Settings error (${settingsError.scope}): ${settingsError.error.message}`));
			}
			process.exitCode = 1;
			return true;
		}

		console.log("");
		console.log(chalk.green("Written."));
		console.log(
			chalk.dim(
				"Settings apply on the next hummin start. Env vars (HUMMIN_*) still override stored settings when set.",
			),
		);
		console.log(chalk.dim("Cloud provider keys: /login inside hummin."));
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log("");
		console.log(chalk.red(`Init aborted: ${message}`));
		console.log(chalk.dim("Nothing was written."));
		process.exitCode = 1;
		return true;
	} finally {
		rl.close();
	}
}
