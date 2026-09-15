import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { withLocalInferenceLock } from "../../src/core/local-inference-lock.ts";

const [directory, output, id] = process.argv.slice(2);
await withLocalInferenceLock(
	"http://localhost:19001/v1",
	undefined,
	async () => {
		appendFileSync(output, `start ${id}\n`);
		await delay(150);
		appendFileSync(output, `end ${id}\n`);
	},
	directory,
);
