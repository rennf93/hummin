import { describe, expect, it } from "vitest";
import {
	buildActionCommand,
	type FleetServer,
	fleetControls,
	fleetSettingsToServers,
	performFleetAction,
} from "../extensions/lib/fleet-actions.ts";

const q = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const launchdServer: FleetServer = {
	id: "mac-qwen",
	label: "Qwen 3.8 27B",
	hostLabel: "Mac",
	hostIp: "127.0.0.1",
	port: 9997,
	kind: "launchd",
	target: "com.hummin.qwen",
};

const dockerServer: FleetServer = {
	id: "box-glm",
	label: "GLM 5.3",
	hostLabel: "box",
	hostIp: "192.168.1.10",
	port: 9998,
	kind: "docker",
	target: "glm-server",
};

const controls = {
	domain: "gui/501",
	plistDir: "/Library/LaunchAgents",
	sshHost: "user@box",
	composeDir: "/opt/compose",
};

const okRun = async (): Promise<{ ok: boolean; output: string }> => ({ ok: true, output: "" });

describe("fleet action command building", () => {
	it("builds launchd load+start for start", () => {
		expect(buildActionCommand(launchdServer, "start", controls)).toBe(
			"launchctl load '/Library/LaunchAgents/com.hummin.qwen.plist' 2>/dev/null; launchctl start 'com.hummin.qwen'",
		);
	});

	it("builds launchd stop+unload for stop", () => {
		expect(buildActionCommand(launchdServer, "stop", controls)).toBe(
			"launchctl stop 'com.hummin.qwen'; launchctl unload '/Library/LaunchAgents/com.hummin.qwen.plist'",
		);
	});

	it("builds launchd restart as stop, load, start", () => {
		expect(buildActionCommand(launchdServer, "restart", controls)).toBe(
			"launchctl stop 'com.hummin.qwen'; launchctl load '/Library/LaunchAgents/com.hummin.qwen.plist' 2>/dev/null; launchctl start 'com.hummin.qwen'",
		);
	});

	it("wraps docker compose in one ssh call", () => {
		expect(buildActionCommand(dockerServer, "start", controls)).toBe(
			`ssh -o ConnectTimeout=5 ${q("user@box")} ${q(`cd ${q("/opt/compose")} && sudo docker compose start ${q("glm-server")}`)}`,
		);
	});

	it("refuses docker actions without control endpoints", () => {
		expect(buildActionCommand(dockerServer, "start", { ...controls, sshHost: "", composeDir: "" })).toBeUndefined();
	});

	it("resolves launchd and docker controls from a settings source", () => {
		expect(
			fleetControls({
				getFleetServers: () => [],
				getFleetLaunchd: () => ({ domain: "gui/99", plistDir: "/tmp/plists" }),
				getFleetDocker: () => ({ sshHost: "h", composeDir: "/c" }),
			}),
		).toEqual({ domain: "gui/99", plistDir: "/tmp/plists", sshHost: "h", composeDir: "/c" });
	});

	it("maps fleet settings to display servers with label and host fallbacks", () => {
		const servers = fleetSettingsToServers([
			{ id: "a", hostIp: "10.0.0.1", port: 1, kind: "launchd", target: "t1" },
			{ id: "b", label: "Bee", host: "Box", hostIp: "10.0.0.2", port: 2, kind: "docker", target: "t2" },
		]);
		expect(servers[0].label).toBe("a");
		expect(servers[0].hostLabel).toBe("10.0.0.1");
		expect(servers[1].label).toBe("Bee");
		expect(servers[1].hostLabel).toBe("Box");
	});
});

describe("performFleetAction readiness polling", () => {
	it("starts successfully once the probe reports up", async () => {
		const probes: boolean[] = [false, false, true];
		const result = await performFleetAction(launchdServer, "start", controls, {
			run: okRun,
			probe: async () => probes.shift() ?? true,
			readyDelayMs: 0,
		});
		expect(result).toEqual({ ok: true, up: true, detail: "start: up" });
	});

	it("reports failure when the server never becomes ready", async () => {
		const result = await performFleetAction(launchdServer, "start", controls, {
			run: okRun,
			probe: async () => false,
			readyDelayMs: 0,
		});
		expect(result.ok).toBe(false);
		expect(result.up).toBe(false);
		expect(result.detail).toBe("start: failed to become ready");
	});

	it("reports stop success once the server stops running", async () => {
		const probes: boolean[] = [true, false];
		const result = await performFleetAction(launchdServer, "stop", controls, {
			run: okRun,
			probe: async () => probes.shift() ?? false,
			readyDelayMs: 0,
		});
		expect(result).toEqual({ ok: true, up: false, detail: "stop: stopped" });
	});

	it("reports stop failure when the server keeps running", async () => {
		const result = await performFleetAction(launchdServer, "stop", controls, {
			run: okRun,
			probe: async () => true,
			readyDelayMs: 0,
		});
		expect(result).toEqual({ ok: false, up: true, detail: "stop: still running" });
	});

	it("does not poll after a failed action command", async () => {
		let probeCalls = 0;
		const result = await performFleetAction(launchdServer, "start", controls, {
			run: async () => ({ ok: false, output: "launchctl: could not find service" }),
			probe: async () => {
				probeCalls++;
				return true;
			},
			readyDelayMs: 0,
		});
		expect(probeCalls).toBe(1);
		expect(result.detail).toBe("start failed: launchctl: could not find service");
		expect(result.ok).toBe(false);
	});

	it("short-circuits unconfigured docker endpoints", async () => {
		let runCalls = 0;
		const result = await performFleetAction(
			dockerServer,
			"start",
			{ ...controls, sshHost: "", composeDir: "" },
			{
				run: async () => {
					runCalls++;
					return { ok: true, output: "" };
				},
				probe: async () => true,
				readyDelayMs: 0,
			},
		);
		expect(runCalls).toBe(0);
		expect(result).toEqual({ ok: false, up: false, detail: "docker endpoint is not configured" });
	});

	it("aborts between readiness polls when the signal fires", async () => {
		const controller = new AbortController();
		let probeCalls = 0;
		const result = await performFleetAction(launchdServer, "start", controls, {
			run: async () => {
				controller.abort();
				return { ok: true, output: "" };
			},
			probe: async () => {
				probeCalls++;
				return false;
			},
			readyDelayMs: 0,
			signal: controller.signal,
		});
		expect(probeCalls).toBe(1);
		expect(result.detail).toBe("start aborted");
		expect(result.ok).toBe(false);
	});
});
