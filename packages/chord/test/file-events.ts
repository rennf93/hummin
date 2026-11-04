// Test support: waits until the file events of everything written so far have been delivered. macOS reports the
// changes made just before a watch started after it started (Linux does not), so a test that writes files, starts a
// watcher and then asserts its marks would see those late events as changes. File events arrive in the order of the
// changes, so the event of one more file written now is the last: when it arrives, the earlier ones have.

import { type FSWatcher, mkdtempSync, realpathSync, rmSync, watch } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The files being waited for, by name: resolved when their event arrives. */
const waiting = new Map<string, () => void>();

/**
 * The one directory and watch of the process, made when this module loads and kept: macOS restarts its event stream
 * for every watch started or closed, and a change made meanwhile can be lost, so the helper must never start one after
 * a test wrote the files it waits for.
 */
const sentinel = startSentinel();

let written = 0;

/** Resolves when the file events of every change made before the call have been delivered. */
export async function fileEventsDelivered(): Promise<void> {
	const { dir } = sentinel;
	const name = `last-${written++}`;
	let rewrite: NodeJS.Timeout | undefined;
	await new Promise<void>((resolve) => {
		waiting.set(name, resolve);
		// A write right after a watch starts can be lost while macOS starts its event stream: written again until seen.
		let count = 0;
		const write = (): void => void writeFile(join(dir, name), String(count++));
		write();
		rewrite = setInterval(write, 100);
	}).finally(() => {
		clearInterval(rewrite);
		waiting.delete(name);
	});
	await rm(join(dir, name), { force: true });
}

/** Makes the directory and its watch, removed when the process exits. */
function startSentinel(): { readonly dir: string; readonly watcher: FSWatcher } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "chord-events-")));
	const watcher = watch(dir, (_event, name) => {
		if (name !== null) waiting.get(name)?.();
	});
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	return { dir, watcher };
}
