import http from "node:http";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exemptFromHttpIdleTimeout, isExemptFromHttpIdleTimeout } from "../src/core/http-dispatcher.ts";
import { configureHttpDispatcher } from "../src/core/undici-runtime.ts";

const IDLE_MS = 1_000;
const STALL_MS = 2_500;

function startStallingServer(): Promise<http.Server> {
	const server = http.createServer((_req, res) => {
		// Stall before headers, then again mid-body.
		setTimeout(() => {
			res.writeHead(200);
			res.write("a");
			setTimeout(() => res.end("b"), STALL_MS);
		}, STALL_MS);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("fleet origins are exempt from the HTTP idle timeout", () => {
	let fleet: http.Server;
	let other: http.Server;
	const url = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

	beforeAll(async () => {
		fleet = await startStallingServer();
		other = await startStallingServer();
		exemptFromHttpIdleTimeout(url(fleet));
		configureHttpDispatcher(IDLE_MS);
	});

	afterAll(() => {
		fleet.closeAllConnections();
		other.closeAllConnections();
		fleet.close();
		other.close();
	});

	it("lets a registered fleet origin stall past the configured timeout", async () => {
		const response = await undici.fetch(url(fleet));
		expect(await response.text()).toBe("ab");
	}, 15_000);

	it("still aborts an unregistered origin at the configured timeout", async () => {
		await expect(undici.fetch(url(other)).then((r) => r.text())).rejects.toThrow();
	});

	it("treats empty and unparsable urls as not exempt without throwing", () => {
		expect(isExemptFromHttpIdleTimeout("")).toBe(false);
		expect(isExemptFromHttpIdleTimeout("not a url")).toBe(false);
		expect(() => exemptFromHttpIdleTimeout("")).not.toThrow();
	});
});
