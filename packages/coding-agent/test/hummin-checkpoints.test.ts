import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore, type FileCheckpoint } from "../extensions/lib/checkpoints.ts";

const directories: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hummin-rewind-"));
	directories.push(root);
	const store = new CheckpointStore(root, join(root, ".blobs"));
	const edit = (path: string, content: string): FileCheckpoint => {
		const before = store.snapshot(path);
		writeFileSync(join(root, path), content);
		return { version: 1, path, before, after: store.snapshot(path) };
	};
	return { root, store, edit };
}
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("file rewind", () => {
	it("restores multiple edits, preserves original uncommitted content and removes created files", () => {
		const { root, store, edit } = fixture();
		writeFileSync(join(root, "existing"), "user draft");
		const records = [edit("existing", "first"), edit("existing", "second"), edit("new", "created")];
		const journal: FileCheckpoint[] = [];
		expect(store.restore(records, (change) => journal.push(change))).toEqual(["new", "existing"]);
		expect(readFileSync(join(root, "existing"), "utf8")).toBe("user draft");
		expect(() => statSync(join(root, "new"))).toThrow();
		expect(store.prepare([...records, ...journal])).toEqual([]);
	});
	it("preflights every file before changing any and detects intervening user edits", () => {
		const { root, store, edit } = fixture();
		const records = [edit("a", "agent"), edit("b", "agent")];
		writeFileSync(join(root, "a"), "human");
		expect(() => store.restore(records, () => {})).toThrow("Conflict");
		expect(readFileSync(join(root, "b"), "utf8")).toBe("agent");
	});
	it("detects human changes between two tracked edits", () => {
		const { root, store, edit } = fixture();
		const first = edit("a", "agent one");
		writeFileSync(join(root, "a"), "human");
		const second = edit("a", "agent two");
		expect(() => store.prepare([first, second])).toThrow("Conflict");
	});
	it("persists snapshots across store instances and preserves file modes", () => {
		const { root, store, edit } = fixture();
		writeFileSync(join(root, "a"), "original");
		chmodSync(join(root, "a"), 0o755);
		const record = edit("a", "agent");
		const resumed = new CheckpointStore(root, join(root, ".blobs"));
		resumed.restore([record], () => {});
		expect(statSync(join(root, "a")).mode & 0o777).toBe(0o755);
		expect(store.snapshot("a").hash).toBe(record.before.hash);
	});
	it("rejects outside paths, symlinks and corrupt blobs", () => {
		const { root, store, edit } = fixture();
		expect(() => store.snapshot("../outside")).toThrow();
		writeFileSync(join(root, "a"), "original");
		symlinkSync(join(root, "a"), join(root, "link"));
		expect(() => store.snapshot("link")).toThrow("symlink");
		const record = edit("a", "agent");
		writeFileSync(join(root, ".blobs", record.before.hash!), "corrupt");
		expect(() => store.prepare([record])).toThrow("Corrupt");
	});
});
