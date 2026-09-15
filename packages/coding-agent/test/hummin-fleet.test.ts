import { describe, expect, it } from "vitest";
import fleetExtension, { DEFAULT_FLEET, fleetSettingsToServers, probeFleet } from "../extensions/hummin-fleet.ts";

describe("hummin fleet extension", () => {
	it("keeps private fleet configuration empty by default", () => expect(DEFAULT_FLEET).toEqual([]));
	it("does not probe an unconfigured fleet", async () =>
		expect(await probeFleet([], { cwd: "/tmp" } as never)).toEqual(new Map()));
	it("registers fleet and status commands", () => {
		const names: string[] = [];
		fleetExtension({ registerCommand: (name: string) => names.push(name) } as never);
		expect(names).toEqual(["fleet", "status"]);
	});

	it("renders all configured fleet rows with generic host labels", () => {
		const servers = fleetSettingsToServers(
			Array.from({ length: 8 }, (_, index) => ({
				id: `s${index}`,
				label: `Model ${index}`,
				host: `host-${index}`,
				hostIp: `10.0.0.${index + 1}`,
				port: 9000 + index,
				kind: "docker" as const,
				target: `container-${index}`,
			})),
		);
		expect(servers).toHaveLength(8);
		expect(servers[0].hostLabel).toBe("host-0");
	});

	it("uses an empty configured fleet without probing", async () => {
		const ctx = { cwd: "/tmp" } as never;
		expect(await probeFleet([], ctx)).toEqual(new Map());
	});
});
