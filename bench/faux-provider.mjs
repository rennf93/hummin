// Offline scripted model for `run.mjs --offline`, loaded with `-e`. Replays one fixed plan per
// fixture through the real agent loop: shell commands, a write of every reference file, final text.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const bench = dirname(fileURLToPath(import.meta.url));
const fixture = process.env.HUMMIN_BENCH_FIXTURE;
const script = JSON.parse(readFileSync(join(bench, "faux-scripts.json"), "utf8"))[fixture];
if (!script) throw new Error(`no offline script for fixture ${fixture}`);

const referenceDir = join(bench, "fixtures", fixture, "reference");
// Dotfiles in reference/ are receipts the fixture's own commands generate.
const writes = readdirSync(referenceDir)
	.filter((name) => !name.startsWith("."))
	.map((name) => ({
		name: "write",
		arguments: { path: name, content: readFileSync(join(referenceDir, name), "utf8") },
	}));
const turns = [
	...script.before.map((command) => [{ name: "bash", arguments: { command } }]),
	writes,
	...script.after.map((command) => [{ name: "bash", arguments: { command } }]),
];
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export default function (pi) {
	pi.registerProvider("bench-faux", {
		baseUrl: "http://localhost:0",
		apiKey: "bench",
		api: "bench-faux",
		models: [
			{
				id: "scripted",
				name: "Scripted",
				reasoning: false,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
		streamSimple(model, context) {
			const turn = context.messages.filter((message) => message.role === "assistant").length;
			const calls = turns[turn];
			const message = {
				role: "assistant",
				content: calls
					? calls.map((call, index) => ({ type: "toolCall", id: `call-${turn}-${index}`, ...call }))
					: [{ type: "text", text: "Done." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...zeroCost, total: 0 } },
				stopReason: calls ? "toolUse" : "stop",
				timestamp: 0,
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
			});
			return stream;
		},
	});
}
