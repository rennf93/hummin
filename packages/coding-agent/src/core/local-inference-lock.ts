import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";

/** Coordinate generations across hummin processes sharing an agent directory.
 * The lease is renewed while streaming; losing it aborts the request.
 * Servers must still serialize requests from other machines/clients.
 */
export async function withLocalInferenceLock<T>(
	baseUrl: string,
	signal: AbortSignal | undefined,
	task: (signal: AbortSignal) => Promise<T>,
	lockDir = join(getAgentDir(), "inference-locks"),
): Promise<T> {
	const url = new URL(baseUrl);
	const key = createHash("sha256").update(url.origin).digest("hex");
	await mkdir(lockDir, { recursive: true, mode: 0o700 });
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		combined.throwIfAborted();
		try {
			release = await lockfile.lock(join(lockDir, key), {
				realpath: false,
				stale: 120_000,
				update: 10_000,
				retries: 0,
				onCompromised: (error) => controller.abort(error),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			await delay(100, undefined, { signal: combined });
		}
	}
	try {
		combined.throwIfAborted();
		return await task(combined);
	} finally {
		await release();
	}
}
