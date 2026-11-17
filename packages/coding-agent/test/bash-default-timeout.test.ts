import { describe, expect, test } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition, createShellToolDefinition } from "../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";

function capturingOps(): { ops: BashOperations; timeouts: Array<number | undefined> } {
	const timeouts: Array<number | undefined> = [];
	const ops: BashOperations = {
		exec: async (_command, _cwd, options) => {
			timeouts.push(options.timeout);
			return { exitCode: 0 };
		},
	};
	return { ops, timeouts };
}

const ctx = {} as ExtensionToolContext;

describe("shell default timeout", () => {
	test("applies the configured default when the call omits a timeout", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createBashToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: 7,
			exposeSessionEnvironment: false,
		});
		await definition.execute("t1", { command: "echo hi" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([7]);
	});

	test("an explicit per-call timeout wins over the default", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createBashToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: 7,
			exposeSessionEnvironment: false,
		});
		await definition.execute("t2", { command: "echo hi", timeout: 2 }, undefined, undefined, ctx);
		expect(timeouts).toEqual([2]);
	});

	test("defaultTimeout 0 disables the default entirely", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createBashToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: 0,
			exposeSessionEnvironment: false,
		});
		await definition.execute("t3", { command: "echo hi" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([undefined]);
	});

	test("no default configured keeps the old behavior", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createBashToolDefinition("/tmp", { operations: ops, exposeSessionEnvironment: false });
		await definition.execute("t4", { command: "echo hi" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([undefined]);
	});

	test('"disabled" disables the default like 0', async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createBashToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: "disabled",
			exposeSessionEnvironment: false,
		});
		await definition.execute("t7", { command: "echo hi" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([undefined]);
	});

	test("powershell passes the default through to its operations", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createPowerShellToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: 9,
			exposeSessionEnvironment: false,
		});
		await definition.execute("t5", { command: "Get-Location" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([9]);
	});

	test('powershell honors "disabled" through the option pick', async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createPowerShellToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: "disabled",
			exposeSessionEnvironment: false,
		});
		await definition.execute("t8", { command: "Get-Location" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([undefined]);
	});

	test("a default above the internal cap is clamped, not thrown", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createBashToolDefinition("/tmp", {
			operations: ops,
			defaultTimeout: 1e9,
			exposeSessionEnvironment: false,
		});
		await definition.execute("t9", { command: "echo hi" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([2_147_483.647]);
	});

	test("the generic shell definition honors the option too", async () => {
		const { ops, timeouts } = capturingOps();
		const definition = createShellToolDefinition(
			"/tmp",
			{
				name: "bash",
				label: "bash",
				shellName: "bash",
				prompt: "$",
				promptSnippet: "run",
				tempFilePrefix: "pi-bash",
			},
			{ operations: ops, defaultTimeout: 3, exposeSessionEnvironment: false },
		);
		await definition.execute("t6", { command: "echo hi" }, undefined, undefined, ctx);
		expect(timeouts).toEqual([3]);
	});
});
