import { afterEach, expect, it } from "vitest";
import { type PendingApproval, type RemoteApprovals, startRemoteControl } from "../extensions/lib/remote.ts";
import { REMOTE_PAGE } from "../extensions/lib/remote-page.ts";

const servers: Awaited<ReturnType<typeof startRemoteControl>>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

function makeApprovals(resolutions: { id: string; allowed: boolean }[]) {
	let pending: PendingApproval | undefined;
	const resolved = new Map<string, boolean>();
	return {
		bridge: {
			pending: () => pending,
			resolve: (id: string, allowed: boolean): "resolved" | "observed" | "unknown" => {
				if (pending?.id !== id) return "unknown";
				const first = !resolved.has(id);
				resolved.set(id, allowed);
				resolutions.push({ id, allowed });
				return first ? "resolved" : "observed";
			},
			answerable: true,
		} satisfies RemoteApprovals,
		setPending: (next: PendingApproval | undefined) => {
			pending = next;
		},
	};
}

it("serializes pending approval state into /state", async () => {
	const resolutions: { id: string; allowed: boolean }[] = [];
	const { bridge, setPending } = makeApprovals(resolutions);
	const server = await startRemoteControl({
		state: () => ({ status: "working" }),
		prompt: () => {},
		abort: () => {},
		approvals: bridge,
	});
	servers.push(server);
	const url = new URL(server.url);
	const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };

	// No approvals bridge-less state untouched; with bridge and nothing pending -> null.
	let state = (await (await fetch(`${url.origin}/state`, { headers })).json()) as { approval?: unknown };
	expect(state.approval).toBeNull();

	setPending({ id: "a1", tool: "bash", input: "rm -rf /tmp/x" });
	state = (await (await fetch(`${url.origin}/state`, { headers })).json()) as {
		approval?: { id: string; tool: string; input: string; answerable: boolean };
	};
	expect(state.approval).toMatchObject({ id: "a1", tool: "bash", input: "rm -rf /tmp/x", answerable: true });

	// Without a bridge, state has no approval key at all.
	const plain = await startRemoteControl({ state: () => ({ status: "idle" }), prompt: () => {}, abort: () => {} });
	servers.push(plain);
	const plainState = (await (
		await fetch(`${new URL(plain.url).origin}/state`, {
			headers: { Authorization: `Bearer ${new URL(plain.url).hash.slice(1)}` },
		})
	).json()) as Record<string, unknown>;
	expect("approval" in plainState).toBe(false);
});

it("/approve requires auth and resolves first-wins with a deny path", async () => {
	const resolutions: { id: string; allowed: boolean }[] = [];
	const { bridge, setPending } = makeApprovals(resolutions);
	const server = await startRemoteControl({
		state: () => ({}),
		prompt: () => {},
		abort: () => {},
		approvals: bridge,
	});
	servers.push(server);
	const base = new URL(server.url).origin;
	const headers = { Authorization: `Bearer ${new URL(server.url).hash.slice(1)}`, "Content-Type": "application/json" };
	const approve = (body: unknown, auth: Record<string, string> = headers) =>
		fetch(`${base}/approve`, { method: "POST", headers: auth, body: JSON.stringify(body) });

	// Auth required like /prompt.
	expect((await approve({ id: "a1", allow: true }, { "Content-Type": "application/json" })).status).toBe(401);

	// Unknown id -> 404, nothing resolved.
	expect((await approve({ id: "nope", allow: true })).status).toBe(404);
	expect(resolutions).toEqual([]);

	// Malformed body.
	expect((await approve({ id: "a1", allow: "yes" })).status).toBe(400);

	setPending({ id: "a1", tool: "bash", input: "ls" });

	// Deny path: first answer wins.
	const deny = await approve({ id: "a1", allow: false });
	expect(deny.status).toBe(202);
	expect(await deny.json()).toMatchObject({ accepted: true, resolved: true });
	expect(resolutions).toEqual([{ id: "a1", allowed: false }]);

	// Replay of the same body is idempotent and does not re-resolve.
	expect((await approve({ id: "a1", allow: false })).status).toBe(200);
	expect(resolutions).toEqual([{ id: "a1", allowed: false }]);

	// Conflicting body for the same id is rejected.
	expect((await approve({ id: "a1", allow: true })).status).toBe(409);
	expect(resolutions).toEqual([{ id: "a1", allowed: false }]);

	// A second approval resolves independently.
	setPending({ id: "a2", tool: "edit", input: "main.ts" });
	expect((await approve({ id: "a2", allow: true })).status).toBe(202);
	expect(resolutions).toEqual([
		{ id: "a1", allowed: false },
		{ id: "a2", allowed: true },
	]);

	// Without a bridge the endpoint is a no-op.
	const plain = await startRemoteControl({ state: () => ({}), prompt: () => {}, abort: () => {} });
	servers.push(plain);
	const plainBase = new URL(plain.url).origin;
	const plainHeaders = {
		Authorization: `Bearer ${new URL(plain.url).hash.slice(1)}`,
		"Content-Type": "application/json",
	};
	expect(
		(await fetch(`${plainBase}/approve`, { method: "POST", headers: plainHeaders, body: '{"id":"x","allow":true}' }))
			.status,
	).toBe(501);
});

it("observes when the terminal dialog answered first", async () => {
	const resolutions: { id: string; allowed: boolean }[] = [];
	const { bridge, setPending } = makeApprovals(resolutions);
	// Simulate the terminal having already answered a1: pre-seed via bridge by
	// resolving from a stale pending state.
	setPending({ id: "a1", tool: "bash", input: "ls" });
	const server = await startRemoteControl({
		state: () => ({}),
		prompt: () => {},
		abort: () => {},
		approvals: bridge,
	});
	servers.push(server);
	const headers = { Authorization: `Bearer ${new URL(server.url).hash.slice(1)}`, "Content-Type": "application/json" };
	// Terminal wins first: resolve directly (as the ui bridge would on dialog close).
	expect(bridge.resolve("a1", true)).toBe("resolved");
	expect(resolutions).toEqual([{ id: "a1", allowed: true }]);
	// Browser answer arrives late (a deny attempt): accepted, but reported as observed, not resolved.
	const late = await fetch(`${new URL(server.url).origin}/approve`, {
		method: "POST",
		headers,
		body: JSON.stringify({ id: "a1", allow: false }),
	});
	expect(late.status).toBe(202);
	expect(await late.json()).toMatchObject({ accepted: true, resolved: false });
	// The bridge observed the late call but it had no resolving effect.
	expect(resolutions).toEqual([
		{ id: "a1", allowed: true },
		{ id: "a1", allowed: false },
	]);
});

it("page renders an approval banner with Approve/Deny and a terminal fallback note", () => {
	expect(REMOTE_PAGE).toContain('id="approval"');
	expect(REMOTE_PAGE).toContain('id="approve"');
	expect(REMOTE_PAGE).toContain('id="deny"');
	expect(REMOTE_PAGE).toContain(">Approve</button>");
	expect(REMOTE_PAGE).toContain(">Deny</button>");
	expect(REMOTE_PAGE).toContain("Approve in terminal.");
	expect(REMOTE_PAGE).toContain("state.approval");
	expect(REMOTE_PAGE).toContain("'/approve'");
});
