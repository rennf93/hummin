import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_NOTIFICATION_CHANNEL,
	DEFAULT_NOTIFICATION_WHEN,
	detectDesktopBackend,
	NOTIFICATION_CHANNELS,
	NOTIFICATION_WHEN_VALUES,
	onNotificationSent,
	parseNotificationChannel,
	parseNotificationWhen,
	resetDesktopBackendCache,
	resolveNotificationChannel,
	resolveNotificationWhen,
	sanitizeNotificationMessage,
	sendTerminalNotification,
	setNotificationGate,
} from "../src/core/terminal-notifications.ts";

describe("parseNotificationChannel", () => {
	it("accepts known channels case-insensitively and trims", () => {
		expect(parseNotificationChannel("off")).toBe("off");
		expect(parseNotificationChannel(" Bell ")).toBe("bell");
		expect(parseNotificationChannel("OSC9")).toBe("osc9");
		expect(parseNotificationChannel("desktop")).toBe("desktop");
		expect(parseNotificationChannel("ALL")).toBe("all");
	});

	it("rejects unknown, empty, and non-string values", () => {
		expect(parseNotificationChannel("toast")).toBeUndefined();
		expect(parseNotificationChannel("")).toBeUndefined();
		expect(parseNotificationChannel(42)).toBeUndefined();
		expect(parseNotificationChannel(undefined)).toBeUndefined();
		expect(parseNotificationChannel(null)).toBeUndefined();
	});

	it("exposes the full channel list including desktop", () => {
		expect(NOTIFICATION_CHANNELS).toEqual(["off", "bell", "osc9", "desktop", "all"]);
	});
});

describe("parseNotificationWhen", () => {
	it("accepts known values case-insensitively and trims", () => {
		expect(parseNotificationWhen("always")).toBe("always");
		expect(parseNotificationWhen(" Unfocused ")).toBe("unfocused");
	});

	it("rejects unknown values", () => {
		expect(parseNotificationWhen("sometimes")).toBeUndefined();
		expect(parseNotificationWhen("")).toBeUndefined();
		expect(parseNotificationWhen(7)).toBeUndefined();
		expect(NOTIFICATION_WHEN_VALUES).toEqual(["always", "unfocused"]);
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

describe("resolveNotificationWhen", () => {
	it("defaults to unfocused when nothing is configured", () => {
		expect(resolveNotificationWhen(undefined, undefined)).toBe(DEFAULT_NOTIFICATION_WHEN);
		expect(resolveNotificationWhen(undefined, undefined)).toBe("unfocused");
	});

	it("env wins over the stored setting; invalid env falls through", () => {
		expect(resolveNotificationWhen("always", "unfocused")).toBe("always");
		expect(resolveNotificationWhen("nonsense", "always")).toBe("always");
		expect(resolveNotificationWhen("nonsense", 3)).toBe("unfocused");
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

	afterEach(() => {
		setNotificationGate(undefined);
		resetDesktopBackendCache();
	});

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

	it("all writes BEL then OSC 9 and spawns the desktop backend when present", () => {
		const spawned: Array<{ command: string; args: string[] }> = [];
		const spawnFn = (command: string, args: string[]) => {
			spawned.push({ command, args });
			return { unref() {}, on() {} };
		};
		writes.length = 0;
		const sent = sendTerminalNotification("all", 'say "hi"', writer, spawnFn, () => ({
			args: (title, message) => ["-e", `display notification "${message}" with title "${title}"`],
		}));
		expect(sent).toBe(true);
		expect(writes).toEqual(["\x07", '\x1b]9;say "hi"\x07']);
		expect(spawned).toEqual([
			{ command: "/usr/bin/osascript", args: ["-e", 'display notification "say \\"hi\\"" with title "hummin"'] },
		]);
	});

	it("desktop-only channel spawns without terminal writes", () => {
		const spawned: Array<{ command: string; args: string[] }> = [];
		const spawnFn = (command: string, args: string[]) => {
			spawned.push({ command, args });
			return { unref() {}, on() {} };
		};
		writes.length = 0;
		expect(
			sendTerminalNotification("desktop", "hello", writer, spawnFn, () => ({
				args: (title: string, message: string) => [title, message],
			})),
		).toBe(true);
		expect(writes).toEqual([]);
		expect(spawned).toHaveLength(1);
	});

	it("skips the desktop backend when detection finds none", () => {
		const spawnFn = () => {
			throw new Error("must not spawn");
		};
		writes.length = 0;
		expect(sendTerminalNotification("desktop", "hello", writer, spawnFn, () => undefined)).toBe(true);
		expect(writes).toEqual([]);
	});

	it("notification gate suppresses every channel", () => {
		setNotificationGate(() => false);
		writes.length = 0;
		const spawned: unknown[] = [];
		const spawnFn = (command: string, args: string[]) => {
			spawned.push({ command, args });
			return { unref() {}, on() {} };
		};
		expect(
			sendTerminalNotification("all", "hello", writer, spawnFn, () => ({
				args: (title: string, message: string) => [title, message],
			})),
		).toBe(false);
		expect(writes).toEqual([]);
		expect(spawned).toEqual([]);
	});

	it("notifies subscribers with the sanitized message and channel", () => {
		const seen: Array<{ message: string; channel: string }> = [];
		const unsubscribe = onNotificationSent((event) => seen.push(event));
		writes.length = 0;
		sendTerminalNotification("osc9", "payload", writer);
		unsubscribe();
		sendTerminalNotification("osc9", "dropped", writer);
		expect(seen).toEqual([{ message: "payload", channel: "osc9" }]);
	});
});

describe("detectDesktopBackend", () => {
	afterEach(() => {
		resetDesktopBackendCache();
	});

	it("returns undefined on unsupported platforms", () => {
		resetDesktopBackendCache();
		expect(detectDesktopBackend("win32", "/usr/bin")).toBeUndefined();
	});

	it("caches the first detection until reset", () => {
		resetDesktopBackendCache();
		// The linux backend resolves notify-send via PATH; manufacture a dir that
		// has it so the test does not depend on the host having a real backend.
		const fakeDir = mkdtempSync(join(tmpdir(), "notify-test-"));
		writeFileSync(join(fakeDir, "notify-send"), "#!/bin/sh\n");
		try {
			const first = detectDesktopBackend("linux", fakeDir);
			const second = detectDesktopBackend("linux", "");
			expect(first).toBeDefined();
			// Second call is served from the cache even with a PATH that would fail.
			expect(second).toBe(first);
			resetDesktopBackendCache();
			expect(detectDesktopBackend("linux", "")).toBeUndefined();
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});
});
