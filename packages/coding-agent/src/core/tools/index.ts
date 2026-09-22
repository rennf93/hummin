export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	/**
	 * When true, the `cwd` passed to this factory takes precedence over
	 * `ExtensionContext.cwd` in cwd-sensitive tools. Without it, `ctx.cwd`
	 * (the live session cwd after a `cd`) wins. Set this when constructing
	 * the built-in tools with an explicit custom cwd (e.g. per-workspace /
	 * per-project instances) so that value is not silently ignored.
	 */
	customCwd?: boolean;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const customCwd = options?.customCwd === true;
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read, customCwd);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash, customCwd);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell, customCwd);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit, customCwd);
		case "write":
			return createWriteToolDefinition(cwd, options?.write, customCwd);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep, customCwd);
		case "find":
			return createFindToolDefinition(cwd, options?.find, customCwd);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls, customCwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const customCwd = options?.customCwd === true;
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read, customCwd);
		case "bash":
			return createBashTool(cwd, options?.bash, customCwd);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell, customCwd);
		case "edit":
			return createEditTool(cwd, options?.edit, customCwd);
		case "write":
			return createWriteTool(cwd, options?.write, customCwd);
		case "grep":
			return createGrepTool(cwd, options?.grep, customCwd);
		case "find":
			return createFindTool(cwd, options?.find, customCwd);
		case "ls":
			return createLsTool(cwd, options?.ls, customCwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const customCwd = options?.customCwd === true;
	return [
		createReadToolDefinition(cwd, options?.read, customCwd),
		createBashToolDefinition(cwd, options?.bash, customCwd),
		createEditToolDefinition(cwd, options?.edit, customCwd),
		createWriteToolDefinition(cwd, options?.write, customCwd),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const customCwd = options?.customCwd === true;
	return [
		createReadToolDefinition(cwd, options?.read, customCwd),
		createGrepToolDefinition(cwd, options?.grep, customCwd),
		createFindToolDefinition(cwd, options?.find, customCwd),
		createLsToolDefinition(cwd, options?.ls, customCwd),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const customCwd = options?.customCwd === true;
	return {
		read: createReadToolDefinition(cwd, options?.read, customCwd),
		bash: createBashToolDefinition(cwd, options?.bash, customCwd),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell, customCwd),
		edit: createEditToolDefinition(cwd, options?.edit, customCwd),
		write: createWriteToolDefinition(cwd, options?.write, customCwd),
		grep: createGrepToolDefinition(cwd, options?.grep, customCwd),
		find: createFindToolDefinition(cwd, options?.find, customCwd),
		ls: createLsToolDefinition(cwd, options?.ls, customCwd),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const customCwd = options?.customCwd === true;
	return [
		createReadTool(cwd, options?.read, customCwd),
		createBashTool(cwd, options?.bash, customCwd),
		createEditTool(cwd, options?.edit, customCwd),
		createWriteTool(cwd, options?.write, customCwd),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const customCwd = options?.customCwd === true;
	return [
		createReadTool(cwd, options?.read, customCwd),
		createGrepTool(cwd, options?.grep, customCwd),
		createFindTool(cwd, options?.find, customCwd),
		createLsTool(cwd, options?.ls, customCwd),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const customCwd = options?.customCwd === true;
	return {
		read: createReadTool(cwd, options?.read, customCwd),
		bash: createBashTool(cwd, options?.bash, customCwd),
		powershell: createPowerShellTool(cwd, options?.powershell, customCwd),
		edit: createEditTool(cwd, options?.edit, customCwd),
		write: createWriteTool(cwd, options?.write, customCwd),
		grep: createGrepTool(cwd, options?.grep, customCwd),
		find: createFindTool(cwd, options?.find, customCwd),
		ls: createLsTool(cwd, options?.ls, customCwd),
	};
}
