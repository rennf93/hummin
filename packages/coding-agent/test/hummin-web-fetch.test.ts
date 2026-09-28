import { expect, test } from "vitest";
import { assertFetchable, classifyIp, decodeIpLiteral } from "../extensions/hummin-web.ts";

// Pure pieces of the web_fetch SSRF guard: literal decoding, address
// classification, and the string-level host gate. The DNS step cannot run in
// unit tests; the private-literal cases cover the same classifier the DNS
// answers go through.

test("decodeIpLiteral normalizes encoded IPv4 forms", () => {
	expect(decodeIpLiteral("127.0.0.1")).toBe("127.0.0.1");
	expect(decodeIpLiteral("2130706433")).toBe("127.0.0.1");
	expect(decodeIpLiteral("0x7f000001")).toBe("127.0.0.1");
	expect(decodeIpLiteral("127.1")).toBe("127.0.0.1");
	expect(decodeIpLiteral("10.1")).toBe("10.0.0.1");
	expect(decodeIpLiteral("0xA.0.0.1")).toBeNull(); // hex only valid in the final part
	expect(decodeIpLiteral("example.com")).toBeNull();
	expect(decodeIpLiteral("::1")).toBeNull();
	expect(decodeIpLiteral("999.999.999.999")).toBeNull(); // non-final octet overflow
});

test("classifyIp blocks private, reserved, and loopback addresses", () => {
	for (const ip of [
		"0.0.0.0",
		"10.1.2.3",
		"127.0.0.1",
		"169.254.1.1",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"100.64.0.1",
		"198.18.0.1",
		"192.0.2.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.5",
		"fe80::1",
		"fc00::1",
		"fd12:3456::1",
		"64:ff9b::7f00:1",
		"2001:db8::1",
	]) {
		expect(classifyIp(ip), ip).toBe("blocked");
	}
});

test("classifyIp passes public addresses", () => {
	for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "198.20.0.1", "2606:4700::1111", "2a01::1"]) {
		expect(classifyIp(ip), ip).toBe("public");
	}
});

test("string host gate rejects private literals and local names up front", () => {
	expect(() => assertFetchable("http://127.0.0.1:8080/")).toThrow(/Blocked host/);
	expect(() => assertFetchable("http://2130706433/")).toThrow(/Blocked host/);
	expect(() => assertFetchable("http://0x7f.0.0.1/")).toThrow(/Blocked host/);
	expect(() => assertFetchable("http://localhost/x")).toThrow(/Blocked host/);
	expect(() => assertFetchable("http://nas.local/x")).toThrow(/Blocked host/);
	expect(() => assertFetchable("ftp://example.com/")).toThrow(/Only http\(s\)/);
	expect(() => assertFetchable("not a url")).toThrow(/Invalid URL/);
	expect(assertFetchable("https://example.com/x").hostname).toBe("example.com");
});
