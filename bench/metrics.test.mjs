import assert from "node:assert/strict";
import { test } from "node:test";
import { measureEvents } from "./metrics.mjs";

test("counts executions and final usage once despite streaming and duplicates", () => {
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [{ type: "text", text: "done" }],
		usage: { totalTokens: 42 },
	};
	const output = [
		{ type: "message_update", message },
		{ type: "message_update", message },
		{ type: "tool_execution_start", toolCallId: "a" },
		{ type: "tool_execution_start", toolCallId: "a" },
		{ type: "tool_execution_end", toolCallId: "a", isError: true },
		{ type: "message_end", message },
		{ type: "message_end", message },
	]
		.map(JSON.stringify)
		.join("\n");
	assert.deepEqual(measureEvents(output), {
		toolCalls: 1,
		toolErrors: 1,
		compactions: 0,
		approvalRequests: 0,
		malformedLines: 0,
		tokens: 42,
		finalText: "done",
	});
});
