import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	classifyProviderRetry,
	isRetryableAssistantError,
	type RetryPolicy,
	retryAssistantCall,
	retryDelayMs,
} from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";
const azurePeakLoadError =
	"The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.";

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it("matches Azure peak-load capacity errors", () => {
		// Regression for #9669.
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: azurePeakLoadError })),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		// Regression for #9627.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "520 status code (no body)" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});

describe("classifyProviderRetry", () => {
	it("classifies transient HTTP statuses as retryable", () => {
		for (const status of [408, 429, 500, 502, 503, 504, 529]) {
			expect(classifyProviderRetry({ status, message: "ignored message" })).toBe("retryable");
			expect(classifyProviderRetry({ statusCode: status, message: "ignored message" })).toBe("retryable");
			const error = Object.assign(new Error("ignored message"), { status });
			expect(classifyProviderRetry(error)).toBe("retryable");
		}
	});

	it("classifies fixed client-error statuses as non-retryable", () => {
		for (const status of [400, 401, 402, 403, 404, 409, 422]) {
			expect(classifyProviderRetry({ status, message: "overloaded" })).toBe("non-retryable");
			expect(classifyProviderRetry({ statusCode: status })).toBe("non-retryable");
		}
	});

	it("leaves statuses without a fixed verdict to the later rules", () => {
		expect(classifyProviderRetry({ status: 418, code: "ECONNRESET" })).toBe("retryable");
		expect(classifyProviderRetry({ status: 418, message: "overloaded" })).toBe("retryable");
		expect(classifyProviderRetry({ status: 418, message: "nothing matches this" })).toBe("unknown");
		expect(classifyProviderRetry({ status: 418 })).toBe("unknown");
	});

	it("classifies transient transport error codes as retryable", () => {
		for (const code of [
			"ECONNRESET",
			"ECONNREFUSED",
			"ETIMEDOUT",
			"EPIPE",
			"UND_ERR_SOCKET",
			"UND_ERR_CONNECT_TIMEOUT",
			"UND_ERR_HEADERS_TIMEOUT",
			"UND_ERR_BODY_TIMEOUT",
		]) {
			expect(classifyProviderRetry({ code })).toBe("retryable");
		}
		expect(classifyProviderRetry({ code: "ENOTFOUND" })).toBe("unknown");
	});

	it("falls back to the provider error patterns for plain strings, unchanged", () => {
		expect(classifyProviderRetry("429 quota exceeded")).toBe("non-retryable");
		expect(classifyProviderRetry("terminated")).toBe("retryable");
		expect(classifyProviderRetry("nothing matches this")).toBe("unknown");
	});

	it("falls back to error.message against the patterns when status and code yield no verdict", () => {
		expect(classifyProviderRetry(new Error("overloaded_error"))).toBe("retryable");
		expect(classifyProviderRetry(new Error("insufficient_quota"))).toBe("non-retryable");
		expect(classifyProviderRetry(new Error("nothing matches this"))).toBe("unknown");
	});

	it("prefers status over code, and status over the message patterns", () => {
		expect(classifyProviderRetry({ status: 401, code: "ECONNRESET", message: "overloaded" })).toBe("non-retryable");
		expect(classifyProviderRetry({ status: 500, code: undefined, message: "quota exceeded" })).toBe("retryable");
		expect(classifyProviderRetry({ code: "ECONNRESET", message: "nothing matches this" })).toBe("retryable");
	});
});

describe("retryDelayMs", () => {
	it("caps agent retry delay", () => {
		// Regression for #8826.
		expect(retryDelayMs({ baseDelayMs: 2000 }, 6)).toBe(60000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 5)).toBe(5000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 0 }, 5)).toBe(0);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not retry a non-retryable error (quota/billing)", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("retries a transient error up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "terminated");
	});

	it("reports capped retry delays", async () => {
		// Regression for #8826.
		let n = 0;
		const policy: RetryPolicy = { enabled: true, maxRetries: 4, baseDelayMs: 10, maxAgentDelayMs: 15 };
		const produce = vi.fn(async () => {
			n++;
			return n < 5
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();

		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });

		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([10, 15, 15, 15]);
	});

	it("stops retrying once a call succeeds", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it("does not retry when policy is disabled", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((attempt: number) => {
			events.push(`retry:${attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
		// Let one error call resolve and the first backoff sleep start, then abort.
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		const res = await p;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
});
