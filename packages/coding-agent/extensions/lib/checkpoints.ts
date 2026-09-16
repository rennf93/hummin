import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FileSnapshot {
	hash: string | null;
	mode: number;
}
export interface FileCheckpoint {
	version: 1;
	path: string;
	before: FileSnapshot;
	after: FileSnapshot;
}

function same(a: FileSnapshot, b: FileSnapshot): boolean {
	return a.hash === b.hash && (a.hash === null || a.mode === b.mode);
}

/** Content-addressed snapshots outside the project. No Git operations. */
export class CheckpointStore {
	private readonly root: string;
	private readonly inputRoot: string;
	private readonly blobs: string;
	constructor(root: string, blobs: string) {
		this.inputRoot = resolve(root);
		this.root = realpathSync(root);
		this.blobs = blobs;
	}

	path(input: string): string {
		const absolute = resolve(this.inputRoot, input);
		let name = relative(this.inputRoot, absolute);
		if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) name = relative(this.root, absolute);
		if (
			!name ||
			name === ".." ||
			name.startsWith(`..${sep}`) ||
			isAbsolute(name) ||
			name.split(sep).includes(".git")
		) {
			throw new Error("Checkpoint path must be a project file outside .git");
		}
		let cursor = this.root;
		for (const segment of name.split(sep)) {
			cursor = join(cursor, segment);
			try {
				if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Checkpoint excludes symlinks: ${name}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return name;
	}

	snapshot(input: string): FileSnapshot {
		const name = this.path(input);
		let fd: number;
		try {
			fd = openSync(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hash: null, mode: 0 };
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) {
				throw new Error(`Checkpoint excludes non-regular, hard-linked, or >2 MiB files: ${name}`);
			}
			const data = readFileSync(fd);
			const hash = createHash("sha256").update(data).digest("hex");
			mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
			try {
				writeFileSync(join(this.blobs, hash), data, { flag: "wx", mode: 0o600 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const now = new Date();
				utimesSync(join(this.blobs, hash), now, now);
			}
			return { hash, mode: stat.mode & 0o777 };
		} finally {
			closeSync(fd);
		}
	}

	/** Expire unused blobs after 30 days, preserving every checkpoint in the open session. */
	prune(retain: ReadonlySet<string>, now = Date.now()): number {
		let names: string[];
		try {
			names = readdirSync(this.blobs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		let removed = 0;
		for (const name of names) {
			if (!/^[a-f0-9]{64}$/.test(name)) continue;
			const file = join(this.blobs, name);
			try {
				const stat = lstatSync(file);
				if (!stat.isFile()) continue;
				if (retain.has(name)) {
					// Refresh retained blobs so another session's sweep also preserves them.
					utimesSync(file, new Date(now), new Date(now));
					continue;
				}
				if (stat.mtimeMs >= now - 30 * 24 * 60 * 60 * 1000) continue;
				unlinkSync(file);
				removed++;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return removed;
	}

	private read(snapshot: FileSnapshot): Buffer {
		if (!snapshot.hash || !/^[a-f0-9]{64}$/.test(snapshot.hash)) throw new Error("Invalid checkpoint hash");
		const data = readFileSync(join(this.blobs, snapshot.hash));
		if (createHash("sha256").update(data).digest("hex") !== snapshot.hash) throw new Error("Corrupt checkpoint data");
		return data;
	}

	prepare(records: FileCheckpoint[]): FileCheckpoint[] {
		const changes = new Map<string, FileCheckpoint>();
		for (const record of [...records].reverse()) {
			if (record.version !== 1) throw new Error("Unsupported checkpoint version");
			const name = this.path(record.path);
			const change = changes.get(name);
			const current = change?.after ?? this.snapshot(name);
			if (!same(current, record.after)) throw new Error(`Conflict: ${name} changed outside these tracked edits`);
			if (record.before.hash) this.read(record.before);
			changes.set(name, { version: 1, path: name, before: change?.before ?? current, after: record.before });
		}
		return [...changes.values()].filter((change) => !same(change.before, change.after));
	}

	restore(records: FileCheckpoint[], applied: (change: FileCheckpoint) => void): string[] {
		const changes = this.prepare(records); // Recheck all files after the review dialog.
		const restored: string[] = [];
		try {
			for (const change of changes) {
				const name = this.path(change.path);
				if (!same(this.snapshot(name), change.before)) throw new Error(`Conflict: ${name} changed during restore`);
				const absolute = join(this.root, name);
				if (change.after.hash === null) {
					unlinkSync(absolute);
				} else {
					const data = this.read(change.after);
					mkdirSync(dirname(absolute), { recursive: true });
					const flags =
						constants.O_RDWR |
						constants.O_NOFOLLOW |
						(change.before.hash === null ? constants.O_CREAT | constants.O_EXCL : 0);
					const fd = openSync(absolute, flags, change.after.mode);
					try {
						const stat = fstatSync(fd);
						if (!stat.isFile() || stat.nlink !== 1)
							throw new Error(`Conflict: ${name} is no longer a regular file`);
						if (
							change.before.hash !== null &&
							createHash("sha256").update(readFileSync(fd)).digest("hex") !== change.before.hash
						) {
							throw new Error(`Conflict: ${name} changed during restore`);
						}
						for (let offset = 0; offset < data.length; ) {
							const count = writeSync(fd, data, offset, data.length - offset, offset);
							if (count === 0) throw new Error(`Unable to write checkpoint: ${name}`);
							offset += count;
						}
						ftruncateSync(fd, data.length);
						fchmodSync(fd, change.after.mode);
					} finally {
						closeSync(fd);
					}
				}
				restored.push(name);
				applied(change);
			}
		} catch (error) {
			throw new Error(`${String(error)}. Restored before failure: ${restored.join(", ") || "none"}`);
		}
		return restored;
	}
}
