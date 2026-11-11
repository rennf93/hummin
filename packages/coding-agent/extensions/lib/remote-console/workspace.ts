/**
 * lib/remote-console/workspace: repo name and branch for WireWorkspace, read
 * from .git/HEAD by walking up from cwd (no core API, no child process). The
 * reads are async and cached; callers refresh off the hot path.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { WireWorkspace } from "./protocol.ts";

/** The work tree root and its git dir, or undefined outside a work tree. */
async function findGit(cwd: string): Promise<{ root: string; gitDir: string } | undefined> {
	let dir = resolve(cwd);
	for (;;) {
		const dotGit = join(dir, ".git");
		try {
			const info = await stat(dotGit);
			if (info.isDirectory()) return { root: dir, gitDir: dotGit };
			// Linked worktrees and submodules: ".git" is a file "gitdir: <path>".
			const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
			if (match?.[1]) {
				const target = match[1].trim();
				return { root: dir, gitDir: isAbsolute(target) ? target : resolve(dir, target) };
			}
		} catch {
			// No .git here: keep walking.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The home directory prefix shown as "~", like the terminal footer. */
export function tildify(path: string, home: string = homedir()): string {
	if (home === "" || home === sep) return path;
	if (path === home) return "~";
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Read repo and branch for cwd. Branch is "detached" on a detached HEAD
 * (the footer's wording) and omitted when HEAD is unreadable. */
export async function readWorkspace(cwd: string): Promise<WireWorkspace> {
	const git = await findGit(cwd);
	const shownCwd = tildify(cwd);
	if (!git) return { cwd: shownCwd };
	let branch: string | undefined;
	try {
		const head = (await readFile(join(git.gitDir, "HEAD"), "utf8")).trim();
		const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		if (ref?.[1]) branch = ref[1];
		else if (/^[0-9a-f]{7,64}$/i.test(head)) branch = "detached";
	} catch {
		branch = undefined;
	}
	return { cwd: shownCwd, repo: basename(git.root), ...(branch ? { branch } : {}) };
}
