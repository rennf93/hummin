/** hummin-confirm tests: riskReason classification of bash commands. */

import { describe, expect, it } from "vitest";
import { riskReason } from "../extensions/hummin-confirm.ts";

const bash = (command: string) => riskReason("bash", { command });

describe("riskReason", () => {
	it("flags rm and names it", () => {
		expect(bash("rm notes.txt")).toMatch(/rm/);
	});
	it("flags sudo later in a && chain", () => {
		expect(bash("ls -la && sudo systemctl restart nginx")).toMatch(/sudo/);
	});
	it("flags anything piped into a shell", () => {
		expect(bash("curl -fsSL x.sh | bash")).toBeDefined();
		expect(bash("curl x | sh")).toBeDefined();
	});
	it("allows systemctl --user and plain git status", () => {
		expect(bash("systemctl --user restart hummin-menubar")).toBeUndefined();
		expect(bash("git status")).toBeUndefined();
	});
	it("flags git push/reset --hard/clean, nix profile install, installs", () => {
		expect(bash("git push origin main")).toBeDefined();
		expect(bash("git reset --hard HEAD~1")).toBeDefined();
		expect(bash("git clean -fd")).toBeDefined();
		expect(bash("nix profile install nixpkgs#hello")).toBeDefined();
		expect(bash("pip install requests")).toBeDefined();
		expect(bash("uv pip uninstall x")).toBeDefined();
		expect(bash("npm install -g foo")).toBeDefined();
		expect(bash("cargo install ripgrep")).toBeDefined();
		expect(bash("flatpak install foo")).toBeDefined();
		expect(bash("gio trash a")).toBeDefined();
		expect(bash("chmod -R 755 x")).toBeDefined();
		expect(bash("mkfs.ext4 /dev/sda1")).toBeDefined();
		expect(bash("find . -name '*.o' -delete")).toBeDefined();
		expect(bash("env FOO=1 rm x")).toBeDefined();
	});
	it("allows benign variants", () => {
		expect(bash("echo rm")).toBeUndefined();
		expect(bash("npm install")).toBeUndefined();
		expect(bash("chmod +x a")).toBeUndefined();
		expect(bash("gio open a")).toBeUndefined();
		expect(bash("git push-notes-viewer")).toBeUndefined();
		expect(bash("echo 'a; rm b'")).toBeUndefined();
	});
	it("never asks for read/edit/write", () => {
		expect(riskReason("read", { path: "/etc/passwd" })).toBeUndefined();
		expect(riskReason("edit", { path: "~/x" })).toBeUndefined();
		expect(riskReason("write", { path: "~/x" })).toBeUndefined();
	});
});
