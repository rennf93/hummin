import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import humminLocalExtension, {
	FLEET_HEALTH_MAX_AGE_MS,
	type FleetHealthEntry,
	type FleetHealthState,
	fleetServerKey,
	freshFleetEntry,
	mergeFleetHealth,
	parseFleetHealth,
} from "../extensions/hummin-local.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		openAICompletionsApi: () => ({ stream: vi.fn(), streamSimple: vi.fn() }),
	};
});

interface RegisteredProvider {
	id: string;
	getModels(): readonly { id: string; contextWindow: number; name: string }[];
}

function fakeApi(providers: RegisteredProvider[]): ExtensionAPI {
	return {
		registerProvider: (provider: RegisteredProvider) => providers.push(provider),
		on: () => () => {},
	} as unknown as ExtensionAPI;
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function entry(overrides: Partial<FleetHealthEntry> = {}): FleetHealthEntry {
	return {
		lastSeen: new Date().toISOString(),
		contextWindow: 8192,
		models: ["remembered-model"],
		endpoint: "http://127.0.0.1:19997",
		...overrides,
	};
}

const tempDirs: string[] = [];

function tempFile(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hummin-fleet-health-test-"));
	tempDirs.push(dir);
	return join(dir, name);
}

beforeEach(() => {
	vi.stubEnv("HUMMIN_FLEET_HEALTH_FILE", tempFile("fleet-health.json"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("fleet health pure helpers", () => {
	it("fleetServerKey matches the engine-host-port provider grouping", () => {
		expect(fleetServerKey("llamacpp", "NAS", 8080)).toBe("llamacpp-NAS-8080");
	});

	it("mergeFleetHealth preserves other servers and lets updates win", () => {
		const previous: FleetHealthState = {
			servers: { kept: entry({ endpoint: "http://kept:1" }), replaced: entry({ contextWindow: 1 }) },
		};
		const merged = mergeFleetHealth(previous, { replaced: entry({ contextWindow: 2 }), added: entry() });

		expect(Object.keys(merged.servers).sort()).toEqual(["added", "kept", "replaced"]);
		expect(merged.servers.kept?.endpoint).toBe("http://kept:1");
		expect(merged.servers.replaced?.contextWindow).toBe(2);
		expect(merged.servers.added).toBeDefined();
		expect(mergeFleetHealth(undefined, { only: entry() }).servers.only).toBeDefined();
	});

	it("freshFleetEntry enforces the max age window", () => {
		const now = Date.now();
		const state: FleetHealthState = {
			servers: {
				fresh: entry({ lastSeen: new Date(now - 1000).toISOString() }),
				stale: entry({ lastSeen: new Date(now - FLEET_HEALTH_MAX_AGE_MS - 1000).toISOString() }),
				boundary: entry({ lastSeen: new Date(now - FLEET_HEALTH_MAX_AGE_MS).toISOString() }),
			},
		};
		expect(freshFleetEntry(state, "fresh", now)).toBeDefined();
		expect(freshFleetEntry(state, "stale", now)).toBeUndefined();
		// Exactly at the max age still counts as fresh (inclusive bound).
		expect(freshFleetEntry(state, "boundary", now)).toBeDefined();
		expect(freshFleetEntry(state, "missing", now)).toBeUndefined();
		expect(freshFleetEntry(undefined, "fresh", now)).toBeUndefined();
	});

	it("parseFleetHealth drops malformed entries and tolerates garbage", () => {
		const good = entry();
		const parsed = parseFleetHealth(JSON.stringify({ servers: { good, bad: { lastSeen: "nope" }, ugly: null } }));
		expect(Object.keys(parsed.servers)).toEqual(["good"]);
		expect(parseFleetHealth("not json")).toEqual({ servers: {} });
		expect(parseFleetHealth("[1,2]")).toEqual({ servers: {} });
		expect(parseFleetHealth(JSON.stringify({ servers: "nope" }))).toEqual({ servers: {} });
	});
});

describe("fleet health file persistence", () => {
	it("persists last-known-good discovery for reachable servers", async () => {
		const healthFile = process.env.HUMMIN_FLEET_HEALTH_FILE!;
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19996");
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL): Promise<Response> => {
				const url = String(input);
				if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "live-model" }] }));
				return Promise.resolve(response({ default_generation_settings: { n_ctx: 32768 } }));
			}),
		);

		await humminLocalExtension(fakeApi([]));

		const state = parseFleetHealth(readFileSync(healthFile, "utf8"));
		const saved = state.servers[fleetServerKey("llamacpp", "127.0.0.1", 19996)];
		expect(saved?.contextWindow).toBe(32768);
		expect(saved?.models).toEqual(["live-model"]);
		expect(saved?.endpoint).toBe("http://127.0.0.1:19996");
		expect(Number.isFinite(Date.parse(saved?.lastSeen ?? ""))).toBe(true);
	});

	it("fills the offline catalog from a fresh persisted entry when the server is down", async () => {
		const healthFile = process.env.HUMMIN_FLEET_HEALTH_FILE!;
		writeFileSync(
			healthFile,
			JSON.stringify({ servers: { [fleetServerKey("llamacpp", "127.0.0.1", 19997)]: entry() } }),
		);
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19997");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
		const providers: RegisteredProvider[] = [];

		await humminLocalExtension(fakeApi(providers));

		const model = providers[0]?.getModels()[0];
		expect(model?.id).toBe("remembered-model");
		expect(model?.contextWindow).toBe(8192);
		expect(model?.name).toContain("(offline - start from menubar)");
	});

	it("ignores persisted entries past the max age", async () => {
		const healthFile = process.env.HUMMIN_FLEET_HEALTH_FILE!;
		writeFileSync(
			healthFile,
			JSON.stringify({
				servers: {
					[fleetServerKey("llamacpp", "127.0.0.1", 19998)]: entry({
						lastSeen: new Date(Date.now() - FLEET_HEALTH_MAX_AGE_MS - 60_000).toISOString(),
					}),
				},
			}),
		);
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19998");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
		const providers: RegisteredProvider[] = [];

		await humminLocalExtension(fakeApi(providers));

		expect(providers).toHaveLength(0);
	});

	it("prefers a fresh persisted context window over the env fallback when /props is missing", async () => {
		const healthFile = process.env.HUMMIN_FLEET_HEALTH_FILE!;
		writeFileSync(
			healthFile,
			JSON.stringify({ servers: { [fleetServerKey("llamacpp", "127.0.0.1", 19999)]: entry() } }),
		);
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:19999");
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL): Promise<Response> => {
				const url = String(input);
				if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "props-less" }] }));
				return Promise.resolve(response({}, 404));
			}),
		);
		const providers: RegisteredProvider[] = [];

		await humminLocalExtension(fakeApi(providers));

		expect(providers[0]?.getModels()[0]?.contextWindow).toBe(8192);
	});

	it("does not resurrect remembered models for a server that answered", async () => {
		const healthFile = process.env.HUMMIN_FLEET_HEALTH_FILE!;
		writeFileSync(
			healthFile,
			JSON.stringify({
				servers: {
					[fleetServerKey("llamacpp", "127.0.0.1", 20001)]: entry({
						models: ["retired-model"],
					}),
				},
			}),
		);
		vi.stubEnv("HUMMIN_INSTANCES", "http://127.0.0.1:20001");
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL): Promise<Response> => {
				const url = String(input);
				if (url.endsWith("/v1/models")) return Promise.resolve(response({ data: [{ id: "current-model" }] }));
				return Promise.resolve(response({}, 404));
			}),
		);
		const providers: RegisteredProvider[] = [];

		await humminLocalExtension(fakeApi(providers));

		const ids = providers[0]?.getModels().map((model) => model.id) ?? [];
		expect(ids).toEqual(["current-model"]);
	});
});
