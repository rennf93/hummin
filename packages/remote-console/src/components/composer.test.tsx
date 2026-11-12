// Composer: keyboard inset from visualViewport, and busy state while send or abort is in flight.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../connection.ts";
import { mount } from "../renderer/test/mount.tsx";
import { Composer } from "./Composer.tsx";

const ok: ActionResult = { ok: true, status: 202 };

function props(over: Partial<Parameters<typeof Composer>[0]> = {}): Parameters<typeof Composer>[0] {
	return {
		hostId: "h1",
		queue: null,
		disabled: false,
		onSend: () => Promise.resolve(ok),
		onAbort: () => Promise.resolve(ok),
		...over,
	};
}

function type(text: string): Promise<void> {
	return act(async () => {
		const input = document.querySelector<HTMLTextAreaElement>("[data-rc-composer-input]") as HTMLTextAreaElement;
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(window, "visualViewport");
});

describe("composer keyboard inset", () => {
	it("sets --rc-keyboard-inset once per frame and removes it on unmount", async () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
		const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 20 });
		Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
		const mounted = await mount(<Composer {...props()} />);
		const root = document.documentElement;
		viewport.dispatchEvent(new Event("resize"));
		viewport.dispatchEvent(new Event("scroll"));
		expect(frames.length).toBe(1);
		frames[0]?.(0);
		expect(root.style.getPropertyValue("--rc-keyboard-inset")).toBe("280px");
		viewport.height = 900;
		viewport.dispatchEvent(new Event("resize"));
		frames[1]?.(0);
		expect(root.style.getPropertyValue("--rc-keyboard-inset")).toBe("0px");
		await mounted.unmount();
		expect(root.style.getPropertyValue("--rc-keyboard-inset")).toBe("");
	});

	it("mounts without a visualViewport", async () => {
		Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
		const mounted = await mount(<Composer {...props()} />);
		await mounted.unmount();
	});
});

describe("composer busy controls", () => {
	it("marks send busy while the prompt POST is in flight", async () => {
		let settle: (result: ActionResult) => void = () => undefined;
		const mounted = await mount(
			<Composer
				{...props({
					onSend: () =>
						new Promise((resolve) => {
							settle = resolve;
						}),
				})}
			/>,
		);
		try {
			await type("hello");
			const send = () => document.querySelector("[data-rc-send]");
			await act(async () => (send() as HTMLButtonElement).click());
			expect(send()?.getAttribute("aria-busy")).toBe("true");
			await act(async () => settle(ok));
			expect(send()?.getAttribute("aria-busy")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("marks stop busy while the abort request is in flight", async () => {
		let settle: (result: ActionResult) => void = () => undefined;
		const mounted = await mount(
			<Composer
				{...props({
					working: true,
					onAbort: () =>
						new Promise((resolve) => {
							settle = resolve;
						}),
				})}
			/>,
		);
		try {
			const stop = () => document.querySelector("[data-rc-abort]");
			expect(stop()?.getAttribute("aria-label")).toBe("Stop");
			await act(async () => (stop() as HTMLButtonElement).click());
			expect(stop()?.getAttribute("aria-busy")).toBe("true");
			await act(async () => settle(ok));
			expect(stop()?.getAttribute("aria-busy")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});
