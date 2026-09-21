import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { createInterface, Interface } from "readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionsCommand } from "../src/cli/sessions.ts";

// Fake only the interactive confirm prompt. Stream-backed uses of readline
// (session file parsing inside session-manager) must reach the real
// implementation, so calls with a non-stdin input are delegated to it.
let answerProvider: (prompt: string, cb: (answer: string) => void) => void = () => {};

vi.mock("readline", async (importOriginal) => {
	const actualReadline = (await importOriginal()) as {
		createInterface: (options?: Parameters<typeof createInterface>[0]) => Interface;
	};
	return {
		createInterface: (options?: Parameters<typeof createInterface>[0]) => {
			if (options && "input" in options && options.input !== process.stdin) {
				return actualReadline.createInterface(options);
			}
			return {
				question: (prompt: string, cb: (answer: string) => void) => answerProvider(prompt, cb),
				close: () => {},
				on: () => {},
			} as unknown as Interface;
		},
	};
});

interface FixtureSession {
	id: string;
	cwd?: string;
	name?: string;
	created?: number;
	modified?: number;
	messages?: Array<{ role: "user" | "assistant"; text: string }>;
	parentSession?: string;
}

let tempDir: string;

function writeSession(session: FixtureSession): string {
	const created = session.created ?? Date.now();
	const modified = session.modified ?? created;
	const lines: unknown[] = [
		{
			type: "session",
			id: session.id,
			timestamp: new Date(created).toISOString(),
			cwd: session.cwd ?? "/tmp/test-projects/acme",
			...(session.parentSession ? { parentSession: session.parentSession } : {}),
		},
	];
	if (session.name) {
		lines.push({
			type: "session_info",
			id: `${session.id}-info`,
			parentId: session.id,
			timestamp: new Date(created).toISOString(),
			name: session.name,
		});
	}
	const messages = session.messages ?? [{ role: "user", text: `message ${session.id}` }];
	let parent = session.id;
	messages.forEach((message, index) => {
		lines.push({
			type: "message",
			id: `${session.id}-m${index}`,
			parentId: parent,
			timestamp: new Date(modified + index).toISOString(),
			message: { role: message.role, content: message.text },
		});
		parent = `${session.id}-m${index}`;
	});
	const file = join(tempDir, `${session.id}.jsonl`);
	writeFileSync(file, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

async function run(
	args: string[],
	extra: { cwd?: string; sessionDir?: string } = {},
): Promise<{ log: string; error: string; handled: boolean }> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const callArgs = [...args];
	if (extra.sessionDir) callArgs.push("--session-dir", extra.sessionDir);
	const handled = await handleSessionsCommand(callArgs, { cwd: extra.cwd });
	return {
		// Usage text goes to stdout directly; listing output via console.log.
		log: [...logSpy.mock.calls, ...stdoutSpy.mock.calls].map((call) => call.map(String).join("")).join("\n"),
		error: errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n"),
		handled,
	};
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "hummin-sessions-test-"));
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sessions --help", () => {
	it("lists sessions and returns handled for the bare command", async () => {
		writeSession({ id: "bare0000000001" });
		const { log, handled } = await run([], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(log).toContain("bare0000000001".slice(0, 12));
	});

	it("prints usage for an explicit --help flag", async () => {
		const { log, handled } = await run(["--help"]);
		expect(handled).toBe(true);
		expect(log).toContain("Manage conversation sessions");
	});

	it("prints usage for a subcommand --help flag", async () => {
		const { log, handled } = await run(["rm", "--help"]);
		expect(handled).toBe(true);
		expect(log).toContain("rm <id>");
	});
});

describe("sessions list", () => {
	it("lists sessions sorted by most recent modification", async () => {
		writeSession({ id: "aaa000000000", created: 1000, modified: 1000 });
		writeSession({ id: "bbb111111111", created: 2000, modified: 2000 });
		writeSession({ id: "ccc222222222", created: 3000, modified: 3000 });

		const { log, handled } = await run(["list"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(log).toContain("WHEN");
		expect(log).toContain("MSGS");
		expect(log).toContain("PROJECT");
		// Sorted by modified desc: ccc first, aaa last.
		expect(log.indexOf("ccc222222222")).toBeLessThan(log.indexOf("bbb111111111"));
		expect(log.indexOf("bbb111111111")).toBeLessThan(log.indexOf("aaa000000000"));
	});

	it("truncates ids to 12 characters in the output", async () => {
		writeSession({ id: "a".repeat(20) });
		const { log } = await run(["ls"], { sessionDir: tempDir });
		expect(log).toContain("a".repeat(12));
		expect(log).not.toContain("a".repeat(20));
	});

	it("names empty sessions", async () => {
		writeSession({ id: "zzz999999999" });
		const { log } = await run(["ls"], { sessionDir: tempDir });
		expect(log).toContain("(unnamed)");
	});

	it("reports remaining sessions beyond the limit", async () => {
		for (let i = 0; i < 5; i++) {
			writeSession({ id: `s${i}0000000000`, modified: 1000 + i });
		}
		const { log } = await run(["ls", "--limit", "2"], { sessionDir: tempDir });
		expect(log).toContain("3 more");
	});

	it("rejects invalid --limit values", async () => {
		writeSession({ id: "good0000000000" });
		const { handled, error } = await run(["ls", "--limit", "0"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error).toContain("Invalid --limit");
	});

	it("rejects unknown options", async () => {
		const { handled, error } = await run(["ls", "--bogus"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error).toContain("Unknown option");
	});

	it("rejects unknown subcommands", async () => {
		const { handled, error } = await run(["frobnicate"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error).toContain("Unknown sessions subcommand");
	});
});

describe("sessions show", () => {
	it("dispatches subcommands when invoked with the leading sessions keyword", async () => {
		// CLI argv includes the "sessions" keyword itself: ["sessions", "show", id]
		writeSession({ id: "clikeyword00001" });
		const { log, handled } = await run(["sessions", "show", "clikeyword00001"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(log).toContain("clikeyword00001");
	});

	it("shows details for a session by id", async () => {
		const file = writeSession({
			id: "detail00000001",
			name: "Deploy pipeline",
			messages: [{ role: "user", text: "ship it" }],
		});
		const { log, handled } = await run(["show", "detail00000001"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(log).toContain("detail00000001");
		expect(log).toContain("Deploy pipeline");
		expect(log).toContain("File:");
		expect(log).toContain("ship it");
		expect(file).toBeTruthy();
		expect(existsSync(file)).toBe(true);
	});

	it("falls back to a generic message when a session has none", async () => {
		writeSession({ id: "empty0000000001", messages: [] });
		const { log } = await run(["show", "empty0000000001"], { sessionDir: tempDir });
		expect(log).toContain("(no messages)");
	});

	it("reports a missing id", async () => {
		writeSession({ id: "present00000001" });
		const { handled, error } = await run(["show", "missing00000000"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error).toContain("No session found matching");
	});

	it("requires an id", async () => {
		const { handled, error } = await run(["show"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error).toContain("requires a session");
	});
});

describe("sessions rm", () => {
	it("deletes a session when confirmed with --yes", async () => {
		const file = writeSession({ id: "delete000000001" });
		expect(existsSync(file)).toBe(true);
		const { handled } = await run(["rm", "delete000000001", "-y"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("deletes a session after an interactive yes", async () => {
		const file = writeSession({ id: "delete000000002" });
		answerProvider = (_prompt, cb) => cb("y");
		const { handled } = await run(["rm", "delete000000002"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("keeps the session after an interactive no", async () => {
		const file = writeSession({ id: "keep00000000001" });
		answerProvider = (_prompt, cb) => cb("n");
		const { handled } = await run(["rm", "keep00000000001"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(existsSync(file)).toBe(true);
	});

	it("reports a missing id", async () => {
		writeSession({ id: "present000000002" });
		const { handled, error } = await run(["rm", "missing000000000"], { sessionDir: tempDir });
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(error).toContain("No session found matching");
	});
});
