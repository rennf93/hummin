/**
 * lib/remote-console/fleet: read-only WireFleetServer list. The effective
 * settings object and the fleet-health.json file are the only inputs; nothing
 * here probes, starts, stops or restarts a server. The server list comes from
 * hummin-local's own builder (instanceConfigsFrom), so ids and the legacy
 * fallbacks match the providers it registers.
 */
import { readFileSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	fleetHealthFile,
	fleetServerKey,
	freshFleetEntry,
	instanceConfigsFrom,
	parseFleetHealth,
} from "../../hummin-local.ts";
import type { WireFleetServer } from "./protocol.ts";

export interface FleetInputs {
	settings: unknown;
	/** Provider id of the session's current model, if any. */
	activeProvider: string | undefined;
	nowMs?: number;
}

/** True when the server list comes from something the user set up: the env
 * override, fleet.servers, or a non-empty localInstances / colibriInstances
 * (the same reads SettingsManager.getLocalInstances makes before it falls back
 * to its built-in 127.0.0.1:9998/:9997 defaults). */
function hasExplicitInstances(settings: object, manager: SettingsManager): boolean {
	const env = process.env.HUMMIN_INSTANCES?.trim() ?? process.env.HUMMIN_COLIBRI_INSTANCES?.trim();
	if (env) return true;
	if (manager.getFleetServers().length > 0) return true;
	const legacy = settings as { localInstances?: unknown; colibriInstances?: unknown };
	const stored = legacy.localInstances ?? legacy.colibriInstances;
	return Array.isArray(stored) && stored.length > 0;
}

/** Configured servers joined with their record in the fleet health file.
 * `discovery` is "fresh" when the last successful discovery is inside
 * hummin's freshness window, "stale" when the record is older, "none" without
 * a record; it is a record of the last discovery, not a live probe. Never
 * throws. */
export function readFleetServers(inputs: FleetInputs): WireFleetServer[] {
	try {
		const settings = typeof inputs.settings === "object" && inputs.settings !== null ? inputs.settings : {};
		const manager = SettingsManager.inMemory(settings as Parameters<typeof SettingsManager.inMemory>[0]);
		if (!hasExplicitInstances(settings, manager)) return [];
		const configured = instanceConfigsFrom(manager);
		if (configured.length === 0) return [];
		let health: ReturnType<typeof parseFleetHealth> | undefined;
		try {
			health = parseFleetHealth(readFileSync(fleetHealthFile(), "utf8"));
		} catch {
			health = undefined;
		}
		const nowMs = inputs.nowMs ?? Date.now();
		return configured.map((server) => {
			const id = `${server.engine}-${server.hostLabel.toLowerCase()}-${server.port}`;
			const key = fleetServerKey(server.engine, server.hostLabel, server.port);
			const fresh = freshFleetEntry(health, key, nowMs);
			const discovery = fresh ? "fresh" : health?.servers[key] ? "stale" : "none";
			return {
				id,
				engine: server.engine,
				host: server.hostLabel,
				port: server.port,
				discovery,
				models: [...new Set([...(fresh?.models ?? []), ...(server.models ?? []).map((m) => m.id)])],
				active: inputs.activeProvider === id,
			};
		});
	} catch {
		return [];
	}
}
