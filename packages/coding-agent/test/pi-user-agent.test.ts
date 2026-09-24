import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("getPiUserAgent", () => {
	it("formats the pi wire user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent("1.2.3");

		// pi/ prefix is a wire contract: pi.dev's catalog protocol redirects
		// `pi/<version>` user agents to version-negotiated shards.
		expect(userAgent).toBe(`pi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^pi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
