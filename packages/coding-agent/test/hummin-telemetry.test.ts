import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emitTelemetryEvent,
	FileTelemetryEventSink,
	getTelemetryEventSink,
	SettingsManager,
	setTelemetryEventSink,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import humminTelemetry, { telemetryInstallEnabled } from "../extensions/hummin-telemetry.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hummin-telemetry-test-"));
	tempDirs.push(dir);
	return dir;
}

function fakeApi(): { api: ExtensionAPI; handlers: Map<string, (...args: never[]) => unknown> } {
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const api = {
		on: (name: string, handler: (...args: never[]) => unknown) => {
			handlers.set(name, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function stubSettings(): void {
	vi.spyOn(SettingsManager, "create").mockReturnValue({
		getGlobalSettings: () => ({}),
		getProjectSettings: () => ({}),
	} as unknown as SettingsManager);
}

afterEach(() => {
	setTelemetryEventSink(undefined);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("telemetryInstallEnabled", () => {
	it("lets the env beat settings and only explicit off values disable", () => {
		expect(telemetryInstallEnabled("0", true)).toBe(false);
		expect(telemetryInstallEnabled("false", true)).toBe(false);
		expect(telemetryInstallEnabled(" off ", true)).toBe(false);
		expect(telemetryInstallEnabled("no", true)).toBe(false);
		expect(telemetryInstallEnabled("1", false)).toBe(true);
		expect(telemetryInstallEnabled("yes", false)).toBe(true);
		expect(telemetryInstallEnabled(undefined, false)).toBe(false);
		expect(telemetryInstallEnabled(undefined, undefined)).toBe(true);
		expect(telemetryInstallEnabled(undefined, true)).toBe(true);
		expect(telemetryInstallEnabled("", true)).toBe(true);
	});
});

describe("hummin-telemetry extension", () => {
	it("installs nothing when the kill switch is set", () => {
		stubSettings();
		vi.stubEnv("HUMMIN_TELEMETRY", "0");
		const { api, handlers } = fakeApi();

		humminTelemetry(api);

		expect(getTelemetryEventSink()).toBeUndefined();
		expect(handlers.size).toBe(0);
	});

	it("installs a pid-keyed file sink and captures emitted events", () => {
		stubSettings();
		const dir = makeTempDir();
		vi.stubEnv("HUMMIN_TELEMETRY_DIR", dir);
		const { api } = fakeApi();

		humminTelemetry(api);

		const sink = getTelemetryEventSink();
		expect(sink).toBeInstanceOf(FileTelemetryEventSink);
		expect((sink as FileTelemetryEventSink).path).toBe(join(dir, `pid-${process.pid}.jsonl`));

		emitTelemetryEvent("test_event", { value: 1, dropped: undefined });
		const lines = readFileSync(join(dir, `pid-${process.pid}.jsonl`), "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as { kind: string; name: string; attributes: Record<string, unknown> };
		expect(record.kind).toBe("event");
		expect(record.name).toBe("test_event");
		expect(record.attributes).toEqual({ value: 1 });
	});

	it("re-keys the sink to the session id on session_start", () => {
		stubSettings();
		const dir = makeTempDir();
		vi.stubEnv("HUMMIN_TELEMETRY_DIR", dir);
		const { api, handlers } = fakeApi();

		humminTelemetry(api);
		const onStart = handlers.get("session_start") as
			| ((event: unknown, ctx: { sessionManager: { getSessionId: () => string } }) => void)
			| undefined;
		expect(onStart).toBeDefined();
		onStart?.({ type: "session_start", reason: "startup" }, { sessionManager: { getSessionId: () => "sess-abc" } });

		emitTelemetryEvent("after_start", {});
		expect(existsSync(join(dir, "sess-abc.jsonl"))).toBe(true);
		const lines = readFileSync(join(dir, "sess-abc.jsonl"), "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]!)).toMatchObject({ name: "after_start" });
	});
});
