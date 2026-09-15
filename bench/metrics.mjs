// JSON mode emits partial updates as well as final messages: count executions
// and final usage once, never sum streaming snapshots.
export function measureEvents(output) {
	const executions = new Set();
	const messages = new Map();
	let malformedLines = 0;
	let toolErrors = 0;
	let compactions = 0;
	let approvalRequests = 0;
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			malformedLines++;
			continue;
		}
		if (event.type === "tool_execution_start") executions.add(event.toolCallId);
		if (event.type === "tool_execution_end" && event.isError) toolErrors++;
		if (event.type === "compaction_end" && event.result) compactions++;
		if (event.type === "ui_prompt_start") approvalRequests++;
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			messages.set(JSON.stringify([message.timestamp, message.content, message.responseId]), message);
		}
	}
	const finalMessages = [...messages.values()];
	return {
		toolCalls: executions.size,
		toolErrors,
		compactions,
		approvalRequests,
		malformedLines,
		tokens: finalMessages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0),
		finalText: finalMessages
			.map((message) =>
				message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
			)
			.join("\n\n"),
	};
}
