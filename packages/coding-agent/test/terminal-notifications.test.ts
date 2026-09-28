import { describe, expect, it } from "vitest";
import {
	DEFAULT_NOTIFICATION_CHANNEL,
	parseNotificationChannel,
	resolveNotificationChannel,
	sanitizeNotificationMessage,
	sendTerminalNotification,
} from "../src/core/terminal-notifications.ts";

describe("parseNotificationChannel", () => {
	it("accepts known channels case-insensitively and trims", () => {
		expect(parseNotificationChannel("off")).toBe("off");
		expect(parseNotificationChannel(" Bell ")).toBe("bell");
		expect(parseNotificationChannel("OSC9")).toBe("osc9");
		expect(parseNotificationChannel("ALL")).toBe("all");
	});

	it("rejects unknown, empty, and non-string values", () => {
		expect(parseNotificationChannel("toast")).toBeUndefined();
		expect(parseNotificationChannel("")).toBeUndefined();
		expect(parseNotificationChannel(42)).toBeUndefined();
		expect(parseNotificationChannel(undefined)).toBeUndefined();
		expect(parseNotificationChannel(null)).toBeUndefined();
	});
});

describe("resolveNotificationChannel", () => {
	it("defaults to bell when nothing is configured", () => {
		expect(resolveNotificationChannel(undefined, undefined)).toBe(DEFAULT_NOTIFICATION_CHANNEL);
		expect(resolveNotificationChannel(undefined, undefined)).toBe("bell");
	});

	it("env wins over the stored setting", () => {
		expect(resolveNotificationChannel("off", "all")).toBe("off");
	});

	it("invalid env falls through to the stored setting, not the default", () => {
		expect(resolveNotificationChannel("nonsense", "osc9")).toBe("osc9");
	});

	it("invalid env and invalid setting fall to the default", () => {
		expect(resolveNotificationChannel("nonsense", 7)).toBe("bell");
	});
});

describe("sanitizeNotificationMessage", () => {
	it("strips control bytes that would terminate an OSC payload", () => {
		expect(sanitizeNotificationMessage("a\x1b]2;evil\x07b")).toBe("a ]2;evil b");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeNotificationMessage("  hello  ")).toBe("hello");
	});

	it("bounds the payload to 200 cells with an ellipsis", () => {
		const long = "x".repeat(500);
		const out = sanitizeNotificationMessage(long);
		expect(out.length).toBe(200);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("sendTerminalNotification", () => {
	const writes: string[] = [];
	const writer = (data: string) => {
		writes.push(data);
	};

	it("writes nothing on off", () => {
		writes.length = 0;
		expect(sendTerminalNotification("off", "hello", writer)).toBe(false);
		expect(writes).toEqual([]);
	});

	it("bell writes only BEL", () => {
		writes.length = 0;
		expect(sendTerminalNotification("bell", "hello", writer)).toBe(true);
		expect(writes).toEqual(["\x07"]);
	});

	it("osc9 writes the sanitized payload", () => {
		writes.length = 0;
		expect(sendTerminalNotification("osc9", "hi \x07there", writer)).toBe(true);
		expect(writes).toEqual(["\x1b]9;hi  there\x07"]);
	});

	it("all writes BEL then OSC 9", () => {
		writes.length = 0;
		expect(sendTerminalNotification("all", "hello", writer)).toBe(true);
		expect(writes).toEqual(["\x07", "\x1b]9;hello\x07"]);
	});
});
