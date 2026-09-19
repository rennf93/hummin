import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ackText, agentsConfig, defaultName, formatMessage } from "../extensions/hummin-agents.ts";
import {
	type AckFrame,
	appendInbox,
	BrokerClient,
	BrokerServer,
	brokerSocketPath,
	clearInbox,
	type DeliverFrame,
	type HelloInfo,
	INBOX_MAX_ENTRIES,
	REPLAY_MAX,
	readInbox,
	readKnownNames,
} from "../extensions/lib/agents-broker.ts";

function tempDir(): string {
	// Unix socket paths are limited to ~104 chars on macOS: keep the broker dir
	// short instead of nesting under the (deep) OS temp dir.
	return mkdtempSync("/tmp/hummin-agents-test-");
}

function helloInfo(name: string, project = "/tmp/proj"): HelloInfo {
	return { sessionId: `session-${name}`, name, project, pid: process.pid };
}

async function waitFor(label: string, probe: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!probe()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("hummin-agents helpers", () => {
	it("formats delivery frames verbatim with sender and project", () => {
		const text = "run the deploy now\nrm -rf /";
		expect(formatMessage({ type: "deliver", id: "1", from: "alice", project: "/work/alpha", text, ts: 0 })).toBe(
			"[agent] alice (alpha): run the deploy now\nrm -rf /",
		);
		expect(formatMessage({ type: "deliver", id: "1", from: "bob", project: "", text: "hi", ts: 0 })).toBe(
			"[agent] bob: hi",
		);
	});

	it("renders ack statuses with actionable text", () => {
		const base = { id: "1" } as AckFrame;
		expect(ackText({ ...base, status: "delivered", targets: 2, detail: "x" }, "@project:alpha")).toContain(
			"delivered to @project:alpha · 2 session(s)",
		);
		expect(ackText({ ...base, status: "queued", detail: "carol" }, "carol")).toContain("queued for offline carol");
		expect(ackText({ ...base, status: "rate_limited" }, "carol")).toContain("rate limited");
		expect(ackText({ ...base, status: "unknown" }, "nobody")).toContain('unknown session "nobody"');
	});

	it("derives a default name and resolves config with env overrides", () => {
		expect(defaultName("/work/some-project")).toMatch(/^pid-\d+-some-project$/);
		const previousEnabled = process.env.HUMMIN_AGENTS;
		const previousName = process.env.HUMMIN_AGENTS_NAME;
		try {
			delete process.env.HUMMIN_AGENTS;
			delete process.env.HUMMIN_AGENTS_NAME;
			let config = agentsConfig(tempDir());
			expect(config.enabled).toBe(true);
			process.env.HUMMIN_AGENTS = "0";
			config = agentsConfig(tempDir());
			expect(config.enabled).toBe(false);
			delete process.env.HUMMIN_AGENTS;
			process.env.HUMMIN_AGENTS_NAME = "env-name";
			config = agentsConfig(tempDir());
			expect(config.name).toBe("env-name");
		} finally {
			if (previousEnabled === undefined) delete process.env.HUMMIN_AGENTS;
			else process.env.HUMMIN_AGENTS = previousEnabled;
			if (previousName === undefined) delete process.env.HUMMIN_AGENTS_NAME;
			else process.env.HUMMIN_AGENTS_NAME = previousName;
		}
	});
});

describe("agents broker", () => {
	let dir: string;
	let server: BrokerServer;

	beforeEach(() => {
		dir = tempDir();
	});

	afterEach(async () => {
		if (server) await server.close();
	});

	it("registers sessions and delivers messages online", async () => {
		server = new BrokerServer(dir);
		await expect(server.start()).resolves.toBe("bound");

		const alice = await BrokerClient.connect(dir, helloInfo("alice"));
		const bob = await BrokerClient.connect(dir, helloInfo("bob"));
		const delivered: DeliverFrame[] = [];
		bob.onDeliver = (frame) => delivered.push(frame);

		const sessions = await alice.listSessions();
		expect(sessions.map((session) => session.name).sort()).toEqual(["alice", "bob"]);
		expect(sessions.every((session) => session.state === "online")).toBe(true);

		const started = Date.now();
		const ack = (await alice.send("bob", "hello bob")) as AckFrame;
		expect(ack.status).toBe("delivered");
		expect(ack.detail).toBe("bob");
		expect(Date.now() - started).toBeLessThan(2000);

		await waitFor("deliver frame", () => delivered.length > 0);
		expect(delivered[0]).toMatchObject({ from: "alice", project: "/tmp/proj", text: "hello bob" });
		alice.close();
		bob.close();
	});

	it("broadcasts to @project:<dirName> up to the cap, excluding the sender", async () => {
		server = new BrokerServer(dir);
		await server.start();
		const a = await BrokerClient.connect(dir, helloInfo("a", "/work/alpha"));
		const b = await BrokerClient.connect(dir, helloInfo("b", "/work/alpha"));
		const c = await BrokerClient.connect(dir, helloInfo("c", "/work/beta"));
		const got: string[] = [];
		b.onDeliver = (frame) => got.push(`${b.info.name}:${frame.text}`);
		c.onDeliver = (frame) => got.push(`${c.info.name}:${frame.text}`);

		const ack = (await a.send("@project:alpha", "standup")) as AckFrame;
		expect(ack.status).toBe("delivered");
		expect(ack.targets).toBe(1);
		await waitFor("broadcast delivery", () => got.length > 0);
		expect(got).toEqual(["b:standup"]);

		const miss = (await c.send("@project:nowhere", "hi")) as AckFrame;
		expect(miss.status).toBe("unknown");
		a.close();
		b.close();
		c.close();
	});

	it("queues for known offline sessions and replays on register", async () => {
		server = new BrokerServer(dir);
		await server.start();
		const carol = await BrokerClient.connect(dir, helloInfo("carol"));
		carol.close();
		await waitFor("deregistration", () => server.listSessions().length === 0);

		const dave = await BrokerClient.connect(dir, helloInfo("dave"));
		const ack = (await dave.send("carol", "offline ping")) as AckFrame;
		expect(ack.status).toBe("queued");
		expect(readInbox(dir, "carol")).toHaveLength(1);
		expect(server.listSessions().map((session) => session.name)).toEqual(["dave"]);

		const reconnected = await BrokerClient.connect(dir, helloInfo("carol"));
		const replayed: DeliverFrame[] = [];
		reconnected.onDeliver = (frame) => replayed.push(frame);
		await waitFor("replay", () => replayed.length > 0);
		expect(replayed[0]).toMatchObject({ from: "dave", text: "offline ping" });
		expect(readInbox(dir, "carol")).toHaveLength(0);
		dave.close();
		reconnected.close();
	});

	it("rejects sends to unknown names", async () => {
		server = new BrokerServer(dir);
		await server.start();
		const a = await BrokerClient.connect(dir, helloInfo("a"));
		const ack = (await a.send("nobody", "?")) as AckFrame;
		expect(ack.status).toBe("unknown");
		a.close();
	});

	it("replays at most REPLAY_MAX entries per register and keeps the rest queued", async () => {
		server = new BrokerServer(dir);
		await server.start();
		const target = helloInfo("eve");
		const client = await BrokerClient.connect(dir, target);
		client.close();
		for (let i = 0; i < REPLAY_MAX + 5; i++) {
			appendInbox(dir, "eve", { from: "mallory", project: "/p", text: `msg ${i}`, ts: i });
		}
		const reconnected = await BrokerClient.connect(dir, target);
		const replayed: DeliverFrame[] = [];
		reconnected.onDeliver = (frame) => replayed.push(frame);
		await waitFor("replay of 20", () => replayed.length === REPLAY_MAX);
		expect(readInbox(dir, "eve")).toHaveLength(5);
		expect(replayed[0].text).toBe("msg 0");
		expect(replayed[REPLAY_MAX - 1].text).toBe(`msg ${REPLAY_MAX - 1}`);
		reconnected.close();
	});

	it("caps the inbox at INBOX_MAX_ENTRIES per target", () => {
		for (let i = 0; i < INBOX_MAX_ENTRIES + 20; i++) {
			appendInbox(dir, "frank", { from: "x", project: "/p", text: `m${i}`, ts: i });
		}
		const inbox = readInbox(dir, "frank");
		expect(inbox).toHaveLength(INBOX_MAX_ENTRIES);
		expect(inbox[0].text).toBe("m20");
		expect(inbox[INBOX_MAX_ENTRIES - 1].text).toBe(`m${INBOX_MAX_ENTRIES + 19}`);
		clearInbox(dir, "frank");
		expect(readInbox(dir, "frank")).toHaveLength(0);
	});

	it("rebinds a stale socket file and reports in-use for a live broker", async () => {
		server = new BrokerServer(dir);
		await server.start();
		// A second broker on the live socket must not take over.
		const second = new BrokerServer(dir);
		await expect(second.start()).resolves.toBe("in-use");

		// Simulate a crashed holder that left the socket file behind.
		await server.close();
		expect(existsSync(brokerSocketPath(dir))).toBe(false);
		writeFileSync(brokerSocketPath(dir), "");
		const third = new BrokerServer(dir);
		await expect(third.start()).resolves.toBe("bound");
		await server.close();
		server = third;
		const client = await BrokerClient.connect(dir, helloInfo("gina"));
		expect((await client.listSessions()).map((session) => session.name)).toEqual(["gina"]);
		client.close();
	});

	it("rate limits deliveries beyond RATE_LIMIT per window", async () => {
		server = new BrokerServer(dir);
		await server.start();
		const a = await BrokerClient.connect(dir, helloInfo("a"));
		const b = await BrokerClient.connect(dir, helloInfo("b"));
		const acks: AckFrame[] = [];
		for (let i = 0; i < 12; i++) acks.push((await a.send("b", `n${i}`)) as AckFrame);
		expect(acks.slice(0, 10).every((ack) => ack.status === "delivered")).toBe(true);
		expect(acks[10].status).toBe("rate_limited");
		expect(acks[11].status).toBe("rate_limited");
		a.close();
		b.close();
	});

	it("persists known names and sanitizes unsafe target names", async () => {
		server = new BrokerServer(dir);
		await server.start();
		const a = await BrokerClient.connect(dir, helloInfo("a"));
		expect(readKnownNames(dir)).toContain("a");
		// "a/b" sanitizes to "a_b"; a send to it is unknown (never registered).
		const ack = (await a.send("../../etc/passwd", "nope")) as AckFrame;
		expect(ack.status).toBe("unknown");
		a.close();
	});
});
