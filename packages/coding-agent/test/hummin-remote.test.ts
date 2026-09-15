import { afterEach, expect, it, vi } from "vitest";
import remoteExtension from "../extensions/hummin-remote.ts";
import { startRemoteControl } from "../extensions/lib/remote.ts";
import type { ExtensionAPI } from "../src/index.ts";

const servers: Awaited<ReturnType<typeof startRemoteControl>>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

it("registers remote control without opening a listener at startup", () => {
	const registerCommand = vi.fn();
	remoteExtension({ on: vi.fn(), registerCommand } as unknown as ExtensionAPI);
	expect(registerCommand).toHaveBeenCalledWith("remote-control", expect.objectContaining({ category: "Session" }));
});

it("requires a token, rejects cross-origin requests, and deduplicates retries", async () => {
	const prompt = vi.fn();
	const abort = vi.fn();
	const server = await startRemoteControl({ state: () => ({ status: "idle" }), prompt, abort });
	servers.push(server);
	const url = new URL(server.url);
	const token = url.hash.slice(1);
	const base = url.origin;
	expect((await fetch(`${base}/state`)).status).toBe(401);
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	expect((await fetch(`${base}/state`, { headers: { ...headers, Origin: "https://attacker.example" } })).status).toBe(
		403,
	);
	expect(await (await fetch(`${base}/state`, { headers })).json()).toEqual({ status: "idle" });
	const send = (text: string) =>
		fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "one", text }) });
	expect((await send("hello")).status).toBe(202);
	expect((await send("hello")).status).toBe(200);
	expect((await send("different")).status).toBe(409);
	expect(prompt).toHaveBeenCalledExactlyOnceWith("hello");
	expect(
		(await fetch(`${base}/abort`, { method: "POST", headers, body: JSON.stringify({ id: "stop" }) })).status,
	).toBe(202);
	expect(abort).toHaveBeenCalledOnce();
});

it("keeps the token out of served HTML and rejects oversized prompts", async () => {
	const server = await startRemoteControl({ state: () => ({}), prompt: vi.fn(), abort: vi.fn() });
	servers.push(server);
	const url = new URL(server.url);
	const token = url.hash.slice(1);
	const page = await fetch(url.origin);
	expect(page.headers.get("cache-control")).toBe("no-store");
	expect(await page.text()).not.toContain(token);
	const result = await fetch(`${url.origin}/prompt`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ id: "big", text: "x".repeat(13_000) }),
	});
	expect(result.status).toBe(400);
});
