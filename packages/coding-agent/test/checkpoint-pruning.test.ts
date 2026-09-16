import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CheckpointStore } from "../extensions/lib/checkpoints.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("expires old blobs while protecting recent, retained, and non-blob entries", () => {
	const directory = mkdtempSync(join(tmpdir(), "hummin-prune-test-"));
	directories.push(directory);
	const blobs = join(directory, "blobs");
	mkdirSync(blobs);
	const now = Date.now();
	const old = new Date(now - 31 * 24 * 60 * 60 * 1000);
	const expired = "a".repeat(64);
	const retained = "b".repeat(64);
	const recent = "c".repeat(64);
	for (const name of [expired, retained, recent, "keep.txt"]) {
		writeFileSync(join(blobs, name), "data");
		if (name !== recent) utimesSync(join(blobs, name), old, old);
	}
	const link = "d".repeat(64);
	symlinkSync(join(blobs, "keep.txt"), join(blobs, link));
	const store = new CheckpointStore(directory, blobs);
	expect(store.prune(new Set([retained]), now)).toBe(1);
	expect(existsSync(join(blobs, expired))).toBe(false);
	for (const name of [retained, recent, "keep.txt", link]) expect(existsSync(join(blobs, name))).toBe(true);
	// A second session must preserve the first session's refreshed checkpoint.
	expect(new CheckpointStore(directory, blobs).prune(new Set(), now + 1000)).toBe(0);
});

test("reusing a snapshot refreshes its retention and missing stores need no cleanup", () => {
	const directory = mkdtempSync(join(tmpdir(), "hummin-prune-test-"));
	directories.push(directory);
	const blobs = join(directory, "blobs");
	const store = new CheckpointStore(directory, blobs);
	expect(store.prune(new Set())).toBe(0);
	writeFileSync(join(directory, "draft"), "keep");
	const snapshot = store.snapshot("draft");
	const file = join(blobs, snapshot.hash!);
	const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
	utimesSync(file, old, old);
	expect(store.snapshot("draft")).toEqual(snapshot);
	expect(store.prune(new Set())).toBe(0);
	expect(existsSync(file)).toBe(true);
});
