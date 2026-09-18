import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildBwrapArgv,
	buildSeatbeltProfile,
	cachedProbe,
	escapeSeatbeltRegexLiteral,
	formatSandboxTable,
	parseSandboxNamespace,
	resolveSandboxConfig,
	secretReadDenySubpaths,
} from "../extensions/hummin-sandbox.ts";

describe("secretReadDenySubpaths", () => {
	it("excludes ~/.ssh, ~/.gnupg and ~/.hummin/agent", () => {
		expect(secretReadDenySubpaths("/home/u")).toEqual([
			join("/home/u", ".ssh"),
			join("/home/u", ".gnupg"),
			join("/home/u", ".hummin", "agent"),
		]);
	});
});

describe("escapeSeatbeltRegexLiteral", () => {
	it("escapes regex metacharacters in paths", () => {
		expect(escapeSeatbeltRegexLiteral("/Users/a.b+c")).toBe("/Users/a\\.b\\+c");
	});
});

describe("buildSeatbeltProfile", () => {
	const profile = buildSeatbeltProfile({
		home: homedir(),
		cwd: "/proj",
		tmpDir: "/tmp/x",
		networkDeny: false,
	});

	it("denies by default and allows reads", () => {
		expect(profile).toContain("(deny default)");
		expect(profile).toContain("(allow file-read*)");
	});

	it("denies secret paths", () => {
		expect(profile).toContain(`(subpath "${join(homedir(), ".ssh")}")`);
		expect(profile).toContain(`(subpath "${join(homedir(), ".gnupg")}")`);
		expect(profile).toContain(`(subpath "${join(homedir(), ".hummin", "agent")}")`);
	});

	it("denies *.env outside the project", () => {
		expect(profile).toMatch(/deny file-read\* \(regex #"\^\(\?!\/proj\)\.\*\/\[\^\/\]\*\\\.env\$"#\)/);
	});

	it("allows writes only to cwd and tmp", () => {
		expect(profile).toContain('(allow file-write* (subpath "/proj"))');
		expect(profile).toContain('(allow file-write* (subpath "/tmp/x"))');
		expect(profile.match(/allow file-write\*/g)).toHaveLength(2);
	});

	it("includes network allow only when network is permitted", () => {
		expect(profile).toContain("(allow network*)");
		const denied = buildSeatbeltProfile({ home: homedir(), cwd: "/proj", tmpDir: "/tmp/x", networkDeny: true });
		expect(denied).not.toContain("allow network");
	});
});

describe("buildBwrapArgv", () => {
	const base = { cwd: "/proj", tmpDir: "/tmp/x", shellPath: "/bin/bash", command: "ls -la" };

	it("ro-binds /, rw-binds cwd and tmp, sets up dev/proc/tmp", () => {
		const argv = buildBwrapArgv({ ...base, networkDeny: false });
		expect(argv.slice(0, 3)).toEqual(["bwrap", "--ro-bind", "/"]);
		expect(argv).toContain("--bind");
		const binds: string[] = [];
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === "--bind") binds.push(argv[i + 1]);
		}
		expect(binds).toEqual(["/proj", "/tmp/x"]);
		expect(argv).toContain("--dev");
		expect(argv).toContain("/dev");
		expect(argv).toContain("--proc");
		expect(argv).toContain("/proc");
		expect(argv).toContain("--tmpfs");
		expect(argv).toContain("/tmp");
	});

	it("unshares the network only when denied", () => {
		expect(buildBwrapArgv({ ...base, networkDeny: true })).toContain("--unshare-net");
		expect(buildBwrapArgv({ ...base, networkDeny: false })).not.toContain("--unshare-net");
	});

	it("terminates with the shell running the command", () => {
		const argv = buildBwrapArgv({ ...base, networkDeny: false });
		expect(argv.slice(-3)).toEqual(["/bin/bash", "-c", "ls -la"]);
	});
});

describe("resolveSandboxConfig", () => {
	it("defaults to off / allow / block", () => {
		expect(resolveSandboxConfig({}, {}, {})).toEqual({ mode: "off", network: "allow", fallback: "block" });
	});

	it("project settings beat global settings", () => {
		expect(
			resolveSandboxConfig(
				{},
				{ sandbox: { mode: "workspace", network: "deny" } },
				{ sandbox: { network: "allow" } },
			),
		).toEqual({ mode: "workspace", network: "allow", fallback: "block" });
	});

	it("env HUMMIN_SANDBOX overrides the mode only", () => {
		expect(resolveSandboxConfig({ HUMMIN_SANDBOX: "workspace" }, { sandbox: { mode: "off" } }, {})).toMatchObject({
			mode: "workspace",
		});
		expect(resolveSandboxConfig({ HUMMIN_SANDBOX: "0" }, { sandbox: { mode: "workspace" } }, {})).toMatchObject({
			mode: "off",
		});
		expect(
			resolveSandboxConfig({ HUMMIN_SANDBOX: "workspace" }, { sandbox: { mode: "workspace", network: "deny" } }, {}),
		).toMatchObject({ network: "deny" });
	});

	it("ignores invalid values", () => {
		expect(parseSandboxNamespace({ mode: "chaos", network: 42 })).toEqual({});
		expect(parseSandboxNamespace("nope")).toEqual({});
		expect(resolveSandboxConfig({ HUMMIN_SANDBOX: "maybe" }, {}, {})).toMatchObject({ mode: "off" });
	});
});

describe("cachedProbe", () => {
	it("runs the probe once per key and serves the cache afterwards", async () => {
		const cache = new Map<string, boolean>();
		let runs = 0;
		const run = async (): Promise<boolean> => {
			runs++;
			return runs === 1;
		};
		expect(await cachedProbe(cache, "k", run)).toBe(true);
		expect(await cachedProbe(cache, "k", run)).toBe(true);
		expect(runs).toBe(1);
		expect(await cachedProbe(cache, "other", run)).toBe(false);
		expect(runs).toBe(2);
	});
});

describe("formatSandboxTable", () => {
	it("aligns keys /doctor-style", () => {
		const text = formatSandboxTable([
			["mode", "workspace"],
			["mechanism", "seatbelt"],
		]);
		expect(text).toBe("mode       workspace\nmechanism  seatbelt");
	});
});
