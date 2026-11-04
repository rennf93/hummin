/** hummin-confirm tests: riskReason classification of bash commands. */

import { afterEach, describe, expect, it } from "vitest";
import humminConfirm, { riskReason } from "../extensions/hummin-confirm.ts";

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
	it("sees through paths, wrappers and git global options", () => {
		for (const c of [
			"/usr/bin/rm x",
			"/run/current-system/sw/bin/rm x",
			"command rm x",
			"env -i rm x",
			"nice -n 5 rm x",
			"git -C . push",
			"git --no-pager push",
			"git -c k=v push",
			"/usr/bin/env rm x",
			"/bin/nohup rm x",
			"/usr/bin/command rm x",
			"/run/current-system/sw/bin/nice -n 5 rm x",
			"time -p rm x",
			"command -p rm x",
			"exec -a x rm y",
			"env -u HOME rm x",
			"env -C dir rm x",
			"env -S 'rm x'",
			"nice --adjustment=5 rm x",
		])
			expect(bash(c), c).toBeDefined();
		expect(bash("git -C . status")).toBeUndefined();
	});
	it("never asks for read/edit/write", () => {
		expect(riskReason("read", { path: "/etc/passwd" })).toBeUndefined();
		expect(riskReason("edit", { path: "~/x" })).toBeUndefined();
		expect(riskReason("write", { path: "~/x" })).toBeUndefined();
	});
});

describe("default export", () => {
	const saved = process.env.HUMMIN_CONFIRM;
	afterEach(() => {
		if (saved === undefined) delete process.env.HUMMIN_CONFIRM;
		else process.env.HUMMIN_CONFIRM = saved;
	});
	const setup = (answer: boolean) => {
		let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
		humminConfirm({
			on: (_n: string, h: typeof handler) => {
				handler = h;
			},
		} as never);
		const messages: string[] = [];
		const ctx = {
			ui: {
				confirm: async (_t: string, m: string) => {
					messages.push(m);
					return answer;
				},
			},
		};
		return {
			run: () => handler?.({ toolName: "bash", input: { command: "rm x" } }, ctx),
			messages,
			has: () => !!handler,
		};
	};

	it("registers nothing without HUMMIN_CONFIRM=1", () => {
		delete process.env.HUMMIN_CONFIRM;
		expect(setup(false).has()).toBe(false);
	});
	it("blocks on deny, with reason and command in the prompt", async () => {
		process.env.HUMMIN_CONFIRM = "1";
		const t = setup(false);
		const r = (await t.run()) as { block: boolean; reason: string };
		expect(r.block).toBe(true);
		expect(r.reason).toMatch(/^Renzo denied:/);
		expect(t.messages[0]).toMatch(/rm/);
		expect(t.messages[0]).toContain("rm x");
	});
	it("allows on confirm", async () => {
		process.env.HUMMIN_CONFIRM = "1";
		expect(await setup(true).run()).toBeUndefined();
	});
});
