import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { withLocalInferenceLock } from "../src/core/local-inference-lock.ts";

const directories: string[] = [];
function directory() {
	const value = mkdtempSync(join(tmpdir(), "hummin-lock-"));
	directories.push(value);
	return value;
}
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("serializes two independent processes through the entire generation", async () => {
	const dir = directory();
	const output = join(dir, "events");
	const worker = fileURLToPath(new URL("./fixtures/local-lock-worker.ts", import.meta.url));
	const run = (id: string) =>
		new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", worker, dir, output, id], {
				stdio: ["ignore", "ignore", "pipe"],
				env: { ...process.env, HUMMIN_MEMORY: "0" },
			});
			let error = "";
			child.stderr.setEncoding("utf8").on("data", (text: string) => {
				error += text;
			});
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
		});
	await Promise.all([run("a"), run("b")]);
	const lines = readFileSync(output, "utf8").trim().split("\n");
	const first = lines[0].slice(-1);
	expect(lines).toEqual([
		`start ${first}`,
		`end ${first}`,
		`start ${first === "a" ? "b" : "a"}`,
		`end ${first === "a" ? "b" : "a"}`,
	]);
});

it("cancels queued requests without entering their generation and releases on exceptions", async () => {
	const dir = directory();
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const first = withLocalInferenceLock(
		"http://localhost:19002/v1",
		undefined,
		async () => {
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		dir,
	);
	await started;
	const controller = new AbortController();
	let called = false;
	const queued = withLocalInferenceLock(
		"http://localhost:19002/other",
		controller.signal,
		async () => {
			called = true;
		},
		dir,
	);
	controller.abort();
	await expect(queued).rejects.toThrow();
	expect(called).toBe(false);
	release();
	await first;
	await expect(
		withLocalInferenceLock(
			"http://localhost:19002/v1",
			undefined,
			async () => {
				throw new Error("failed");
			},
			dir,
		),
	).rejects.toThrow("failed");
	expect(await withLocalInferenceLock("http://localhost:19002/v1", undefined, async () => "next", dir)).toBe("next");
});
