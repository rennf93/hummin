/**
 * hummin-bashguard tests: pure classifier coverage (destructive commands,
 * sed -i guard, path write notices, read-only deny list), the conservative
 * tokenizer, exempt regexes, and config precedence.
 */

import { describe, expect, it } from "vitest";
import {
	classifyCommand,
	compileExempt,
	DEFAULT_BASHGUARD_CONFIG,
	destructiveCommandWarning,
	formatBashguardTable,
	parseBashguardNamespace,
	pathValidation,
	readOnlyDeny,
	resolveBashguardConfig,
	sedValidation,
	tokenize,
} from "../extensions/hummin-bashguard.ts";

const CWD = "/home/user/project";

describe("tokenize", () => {
	it("splits on unquoted whitespace", () => {
		expect(tokenize("echo a  b\tc").tokens).toEqual(["echo", "a", "b", "c"]);
	});

	it("keeps quoted whitespace together and strips quotes", () => {
		expect(tokenize(`rm "my file.txt" 'other name'`).tokens).toEqual(["rm", "my file.txt", "other name"]);
	});

	it("handles escaped characters outside quotes", () => {
		expect(tokenize(String.raw`cp a\ b c`).tokens).toEqual(["cp", "a b", "c"]);
	});

	it("detects unquoted redirection and ignores quoted", () => {
		expect(tokenize("echo hi > out.txt").hasWriteRedirection).toBe(true);
		expect(tokenize(`echo "not > a redirect"`).hasWriteRedirection).toBe(false);
	});

	it("detects unquoted sequence operators and ignores quoted", () => {
		expect(tokenize("a && b").hasSequenceOperator).toBe(true);
		expect(tokenize("a; b").hasSequenceOperator).toBe(true);
		expect(tokenize(`echo "a; b"`).hasSequenceOperator).toBe(false);
	});
});

describe("destructiveCommandWarning", () => {
	it("flags rm -rf /", () => {
		expect(destructiveCommandWarning("rm -rf /", CWD)).toBe(
			"[BashGuard] rm -rf / detected - confirm this is intended",
		);
	});

	it("flags rm -rf ~ and $HOME", () => {
		expect(destructiveCommandWarning("rm -rf ~", CWD)).toContain("rm -rf ~ detected");
		expect(destructiveCommandWarning("rm -fr $HOME", CWD)).toContain("$HOME detected");
	});

	it("does not flag rm -rf inside the project", () => {
		expect(destructiveCommandWarning("rm -rf build", CWD)).toBeUndefined();
		expect(destructiveCommandWarning(`rm -rf "${CWD}/build"`, CWD)).toBeUndefined();
	});

	it("flags git reset --hard", () => {
		expect(destructiveCommandWarning("git reset --hard HEAD~3", CWD)).toBe(
			"[BashGuard] git reset --hard detected - confirm this is intended",
		);
	});

	it("flags force push to protected branches only", () => {
		expect(destructiveCommandWarning("git push --force origin main", CWD)).toContain("protected branch");
		expect(destructiveCommandWarning("git push -f origin master", CWD)).toContain("protected branch");
		expect(destructiveCommandWarning("git push origin :main", CWD)).toContain("protected branch");
		expect(destructiveCommandWarning("git push origin :refs/heads/main", CWD)).toContain("protected branch");
		expect(destructiveCommandWarning("git push --force origin feature/x", CWD)).toBeUndefined();
	});

	it("flags chmod -R 777 /", () => {
		expect(destructiveCommandWarning("chmod -R 777 /", CWD)).toContain("chmod -R 777 / detected");
		expect(destructiveCommandWarning("chmod -R 0777 /", CWD)).toContain("detected");
		expect(destructiveCommandWarning("chmod -R 777 ./public", CWD)).toBeUndefined();
		expect(destructiveCommandWarning("chmod 777 /", CWD)).toBeUndefined(); // not recursive
	});

	it("flags mkfs variants", () => {
		expect(destructiveCommandWarning("mkfs /dev/sda1", CWD)).toContain("mkfs detected");
		expect(destructiveCommandWarning("mkfs.ext4 /dev/sda1", CWD)).toContain("mkfs detected");
	});

	it("flags dd writing to /dev/*", () => {
		expect(destructiveCommandWarning("dd if=img.iso of=/dev/sdb", CWD)).toContain("dd writing to /dev/sdb detected");
		expect(destructiveCommandWarning("dd if=a of=./img.iso", CWD)).toBeUndefined();
	});
});

describe("sedValidation", () => {
	it("warns on sed -i targeting files outside cwd", () => {
		expect(sedValidation("sed -i 's/a/b/' /etc/hosts", CWD)).toContain(
			"sed -i modifies /etc/hosts outside the working directory",
		);
	});

	it("warns on --in-place with ~ paths", () => {
		expect(sedValidation(`sed --in-place s/a/b/ ~/.config/foo`, CWD)).toContain("outside the working directory");
	});

	it("stays quiet for in-project or non-in-place sed", () => {
		expect(sedValidation("sed -i s/a/b/ src/foo.ts", CWD)).toBeUndefined();
		expect(sedValidation("sed s/a/b/ /etc/hosts", CWD)).toBeUndefined();
		expect(sedValidation("sed -i s/a/b/ /tmp/scratch.txt", CWD)).toBeUndefined();
	});
});

describe("pathValidation", () => {
	it("notices redirection writes outside cwd (info only)", () => {
		expect(pathValidation("echo hi > /etc/motd", CWD)).toContain("writes outside the working directory (/etc/motd)");
		expect(pathValidation("echo hi >> /var/log/app.log", CWD)).toContain("/var/log/app.log");
		expect(pathValidation("echo hi >| /etc/motd", CWD)).toContain("/etc/motd");
	});

	it("notices tee, dd of=, cp/mv destinations", () => {
		expect(pathValidation("echo hi | tee /etc/hosts", CWD)).toContain("/etc/hosts");
		expect(pathValidation("dd if=a of=/opt/img", CWD)).toContain("/opt/img");
		expect(pathValidation("cp a /etc/passwd", CWD)).toContain("/etc/passwd");
		expect(pathValidation("mv x ~/y", CWD)).toContain("~/y");
	});

	it("stays quiet for in-project writes", () => {
		expect(pathValidation("echo hi > out.txt", CWD)).toBeUndefined();
		expect(pathValidation("echo hi > ./out.txt", CWD)).toBeUndefined();
		expect(pathValidation("echo hi > ../sibling.txt", CWD)).toContain("../sibling.txt");
		expect(pathValidation("cp a b", CWD)).toBeUndefined();
	});
});

describe("readOnlyDeny", () => {
	it("denies mutating verbs", () => {
		for (const cmd of ["rm x", "mv a b", "dd if=a of=b", "mkfs /dev/sda", "chmod +x f", "chown u:f"]) {
			expect(readOnlyDeny(cmd, CWD)?.reason).toContain("[BashGuard] read-only mode:");
		}
	});

	it("denies git push/reset/clean and npm publish", () => {
		expect(readOnlyDeny("git push origin main", CWD)?.reason).toContain("git mutation");
		expect(readOnlyDeny("git reset", CWD)?.reason).toContain("git mutation");
		expect(readOnlyDeny("git clean -fd", CWD)?.reason).toContain("git mutation");
		expect(readOnlyDeny("npm publish", CWD)?.reason).toContain("npm publish");
	});

	it("denies write redirections and sed -i", () => {
		expect(readOnlyDeny("echo hi > out.txt", CWD)?.reason).toContain("read-only mode");
		expect(readOnlyDeny("sed -i s/a/b/ in.txt", CWD)?.reason).toContain("sed -i");
	});

	it("allows read-only commands", () => {
		for (const cmd of [
			"ls -la",
			"cat file",
			"git status",
			"git log",
			"npm test",
			"npm install",
			"git diff > /dev/null",
		]) {
			expect(readOnlyDeny(cmd, CWD)).toBeUndefined();
		}
	});
});

describe("exempt regexes", () => {
	it("compiles valid patterns and skips invalid ones", () => {
		const compiled = compileExempt(["^git ", "[invalid("]);
		expect(compiled.regexes).toHaveLength(1);
		expect(compiled.raw).toHaveLength(2);
	});

	it("exempt match skips all checks, including hard rules and read-only", () => {
		const config = { ...DEFAULT_BASHGUARD_CONFIG, readOnly: true, exempt: [/^blessed/] };
		expect(classifyCommand("blessed-rm -rf /", CWD, config)).toEqual({ action: "allow" });
	});

	it("non-matching exempt still classifies", () => {
		const config = { ...DEFAULT_BASHGUARD_CONFIG, exempt: [/^safe/] };
		expect(classifyCommand("rm -rf /", CWD, config)).toMatchObject({ action: "advise" });
	});
});

describe("config parsing and precedence", () => {
	it("parses the bashguard namespace", () => {
		const parsed = parseBashguardNamespace({ block: true, readOnly: true, exempt: ["^git status", "[bad("] });
		expect(parsed.block).toBe(true);
		expect(parsed.readOnly).toBe(true);
		expect(parsed.exempt).toHaveLength(1);
		expect(parsed.exemptRaw).toEqual(["^git status", "[bad("]);
	});

	it("ignores unknown shapes", () => {
		expect(parseBashguardNamespace("nope")).toEqual({});
		expect(parseBashguardNamespace({ block: "yes" })).toEqual({});
	});

	it("project settings beat global settings", () => {
		const config = resolveBashguardConfig(
			{},
			{ bashguard: { block: false, readOnly: false } },
			{ bashguard: { block: true } },
		);
		expect(config.block).toBe(true);
		expect(config.readOnly).toBe(false);
	});

	it("defaults are block=false readOnly=false exempt=[]", () => {
		expect(resolveBashguardConfig({}, {}, {})).toEqual({ block: false, readOnly: false, exempt: [], exemptRaw: [] });
	});

	it("HUMMIN_BASHGUARD=0 forces defaults off", () => {
		const config = resolveBashguardConfig(
			{ HUMMIN_BASHGUARD: "0" },
			{ bashguard: { block: true, readOnly: true } },
			{},
		);
		expect(config).toEqual({ block: false, readOnly: false, exempt: [], exemptRaw: [] });
	});
});

describe("classifyCommand", () => {
	it("advises (not blocks) on hard rules when block is false", () => {
		const decision = classifyCommand("git reset --hard", CWD, DEFAULT_BASHGUARD_CONFIG);
		expect(decision).toEqual({
			action: "advise",
			notice: "[BashGuard] git reset --hard detected - confirm this is intended",
		});
	});

	it("blocks hard rules when block is true", () => {
		const config = { ...DEFAULT_BASHGUARD_CONFIG, block: true };
		expect(classifyCommand("git reset --hard", CWD, config)).toEqual({
			action: "block",
			reason: "[BashGuard] git reset --hard detected - confirm this is intended",
		});
	});

	it("read-only deny wins over advise", () => {
		const config = { ...DEFAULT_BASHGUARD_CONFIG, readOnly: true };
		const decision = classifyCommand("rm -rf /", CWD, config);
		expect(decision.action).toBe("block");
		expect((decision as { reason?: string }).reason).toContain("read-only mode");
	});

	it("combines sed and path notices", () => {
		const decision = classifyCommand("sed -i s/a/b/ /etc/hosts > /var/log/x", CWD, DEFAULT_BASHGUARD_CONFIG);
		expect(decision.action).toBe("advise");
		expect((decision as { notice: string }).notice).toContain("sed -i");
		expect((decision as { notice: string }).notice).toContain("/var/log/x");
	});

	it("allows clean commands", () => {
		expect(classifyCommand("ls -la && npm test", CWD, DEFAULT_BASHGUARD_CONFIG)).toEqual({ action: "allow" });
	});
});

describe("formatBashguardTable", () => {
	it("aligns two columns", () => {
		const table = formatBashguardTable([
			["a", "1"],
			["longer", "2"],
		] as const);
		expect(table).toBe("a       1\nlonger  2");
	});
});
