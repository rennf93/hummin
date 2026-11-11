// Smoke test: the token contract exists and the app shell renders its three regions.
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";

function tokenSheet(): string {
	// Trust boundary: vitest provides the real test file path at runtime; import.meta.url is not
	// a file URL under its module runner, so the sheet is read from disk via testPath instead.
	const testPath = expect.getState().testPath;
	if (testPath === undefined) {
		throw new Error("smoke test requires expect.getState().testPath from the vitest runtime");
	}
	return readFileSync(join(dirname(testPath), "tokens.css"), "utf8");
}

describe("remote console smoke", () => {
	it("token sheet defines the customization contract tokens", () => {
		const css = tokenSheet();
		expect(css).toContain("--rc-surface:");
		expect(css).toContain("--rc-accent-hue:");
	});

	it("app shell renders the three data-rc regions", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(createElement(App));
			});
			expect(document.querySelectorAll("[data-rc-region]").length).toBe(3);
			for (const region of ["header", "transcript", "composer"] as const) {
				expect(document.querySelector(`[data-rc-region="${region}"]`)).not.toBeNull();
			}
			expect(document.documentElement.dataset.rcPreset).toBe("studio");
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		}
	});
});
