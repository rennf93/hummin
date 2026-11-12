/**
 * ui/ui.test: primitives contract. Button and IconButton forwarding, Disclosure
 * mounting, usePresence timing, useSmoothText passthrough, Icon coverage.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "../renderer/test/mount.tsx";
import { Button, IconButton } from "./Button.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { SessionId } from "./SessionId.tsx";
import { usePresence } from "./usePresence.ts";
import { useSmoothText } from "./useSmoothText.ts";

const ALL_ICONS: IconName[] = [
	"chevron-right",
	"chevron-down",
	"check",
	"x",
	"alert",
	"arrow-up",
	"arrow-down",
	"stop",
	"plus",
	"sliders",
	"terminal",
	"file",
	"pencil",
	"search",
	"sparkle",
	"clock",
	"spinner",
	"trash",
	"queue",
	"task",
	"question",
	"tool",
	"copy",
];

afterEach(() => {
	vi.useRealTimers();
});

function Presence({ open, exitMs }: { open: boolean; exitMs?: number }) {
	const { mounted, state } = usePresence(open, exitMs);
	return <span data-testid="p" data-mounted={mounted} data-state={state} />;
}

function Smooth({ text, streaming }: { text: string; streaming: boolean }) {
	return <span data-testid="s">{useSmoothText(text, streaming)}</span>;
}

describe("ui primitives", () => {
	it("Button forwards data-* and aria-*", async () => {
		const view = await mount(
			<Button variant="primary" size="sm" icon="plus" data-x="1" aria-label="add">
				Go
			</Button>,
		);
		const el = view.container.querySelector("button");
		expect(el?.getAttribute("data-x")).toBe("1");
		expect(el?.getAttribute("aria-label")).toBe("add");
		expect(el?.className).toContain("rc-btn-primary");
		expect(el?.className).toContain("rc-btn-sm");
		expect(el?.querySelector("svg")).not.toBeNull();
		await view.unmount();
	});

	it("IconButton labels itself and forwards data-*", async () => {
		const view = await mount(<IconButton icon="x" label="Close" data-y="2" />);
		const el = view.container.querySelector("button");
		expect(el?.getAttribute("aria-label")).toBe("Close");
		expect(el?.getAttribute("title")).toBe("Close");
		expect(el?.getAttribute("data-y")).toBe("2");
		expect(el?.className).toContain("rc-iconbtn");
		expect(el?.className).toContain("rc-btn-ghost");
		await view.unmount();
	});

	it("busy Button swallows clicks, sets aria-busy and stays focusable", async () => {
		const onClick = vi.fn();
		const view = await mount(
			<Button busy onClick={onClick}>
				Send
			</Button>,
		);
		const el = view.container.querySelector("button") as HTMLButtonElement;
		expect(el.getAttribute("aria-busy")).toBe("true");
		expect(el.disabled).toBe(false);
		await act(async () => {
			el.click();
		});
		expect(onClick).not.toHaveBeenCalled();
		el.focus();
		expect(document.activeElement).toBe(el);
		expect(el.querySelector(".rc-icon-spinner")).not.toBeNull();
		await view.render(<Button onClick={onClick}>Send</Button>);
		await act(async () => {
			view.container.querySelector("button")?.click();
		});
		expect(onClick).toHaveBeenCalledTimes(1);
		await view.unmount();
	});

	it("busy IconButton swaps the icon for the spinner and swallows clicks", async () => {
		const onClick = vi.fn();
		const view = await mount(<IconButton icon="x" label="Stop" busy onClick={onClick} />);
		const el = view.container.querySelector("button") as HTMLButtonElement;
		expect(el.getAttribute("aria-busy")).toBe("true");
		expect(el.querySelector(".rc-icon-spinner")).not.toBeNull();
		await act(async () => {
			el.click();
		});
		expect(onClick).not.toHaveBeenCalled();
		await view.unmount();
	});

	it("SessionId shows the 8-char prefix, copies the full id and announces Copied", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		try {
			const id = "0123456789abcdef";
			const view = await mount(<SessionId id={id} />);
			const el = view.container.querySelector("button") as HTMLButtonElement;
			expect(el.textContent).toBe("01234567");
			expect(el.getAttribute("aria-label")).toBe(`Copy session id ${id}`);
			expect(el.getAttribute("title")).toBe(id);
			await act(async () => {
				el.click();
			});
			expect(writeText).toHaveBeenCalledWith(id);
			expect(view.container.querySelector("[aria-live=polite]")?.textContent).toBe("Copied");
			await act(async () => {
				vi.advanceTimersByTime(1501);
			});
			expect(view.container.querySelector("[aria-live=polite]")?.textContent).toBe("");
			await view.unmount();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("SessionId stays silent when the clipboard fails and renders nothing for an empty id", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
		try {
			const view = await mount(<SessionId id="abcdefghij" />);
			await act(async () => {
				view.container.querySelector("button")?.click();
			});
			expect(view.container.querySelector("[aria-live=polite]")?.textContent).toBe("");
			await view.render(<SessionId id="" />);
			expect(view.container.innerHTML).toBe("");
			await view.unmount();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("Disclosure mounts children when open and unmounts when closed", async () => {
		const view = await mount(
			<Disclosure open={false}>
				<i data-testid="c" />
			</Disclosure>,
		);
		expect(view.container.querySelector("[data-testid=c]")).toBeNull();
		await view.render(
			<Disclosure open>
				<i data-testid="c" />
			</Disclosure>,
		);
		expect(view.container.querySelector("[data-testid=c]")).not.toBeNull();
		expect(view.container.querySelector(".rc-disclosure")?.getAttribute("data-open")).toBe("true");
		await view.render(
			<Disclosure open={false}>
				<i data-testid="c" />
			</Disclosure>,
		);
		expect(view.container.querySelector("[data-testid=c]")).toBeNull();
		await view.unmount();
	});

	it("usePresence unmounts synchronously at 0ms", async () => {
		const view = await mount(<Presence open />);
		await view.render(<Presence open={false} />);
		const el = view.container.querySelector("[data-testid=p]");
		expect(el?.getAttribute("data-mounted")).toBe("false");
		expect(el?.getAttribute("data-state")).toBe("closed");
		await view.unmount();
	});

	it("usePresence holds the node for exitMs", async () => {
		vi.useFakeTimers();
		const view = await mount(<Presence open exitMs={100} />);
		await view.render(<Presence open={false} exitMs={100} />);
		const read = () => view.container.querySelector("[data-testid=p]")?.getAttribute("data-mounted");
		expect(read()).toBe("true");
		await act(async () => {
			vi.advanceTimersByTime(101);
		});
		expect(read()).toBe("false");
		await view.unmount();
	});

	it("useSmoothText returns the full target when not streaming", async () => {
		const view = await mount(<Smooth text="hello world" streaming={false} />);
		expect(view.container.textContent).toBe("hello world");
		await view.render(<Smooth text="hello world, more" streaming={false} />);
		expect(view.container.textContent).toBe("hello world, more");
		await view.unmount();
	});

	it("useSmoothText keeps pacing while the target grows on every frame", async () => {
		const callbacks = new Map<number, FrameRequestCallback>();
		let nextId = 1;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callbacks.set(nextId, callback);
			return nextId++;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			callbacks.delete(id);
		});
		try {
			let text = "x".repeat(40);
			const view = await mount(<Smooth text={text} streaming />);
			let time = 0;
			const lengths: number[] = [];
			for (let frame = 0; frame < 10; frame++) {
				text += "y".repeat(40);
				await view.render(<Smooth text={text} streaming />);
				time += 16;
				const due = [...callbacks.entries()];
				callbacks.clear();
				await act(async () => {
					for (const [, callback] of due) callback(time);
				});
				lengths.push(view.container.textContent?.length ?? 0);
			}
			expect(lengths[lengths.length - 1]).toBeGreaterThan(lengths[1] ?? 0);
			expect(lengths[lengths.length - 1]).toBeGreaterThan(0);
			expect(lengths[lengths.length - 1]).toBeLessThan(text.length);
			await view.unmount();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("Icon renders an svg for every IconName", async () => {
		for (const name of ALL_ICONS) {
			const view = await mount(<Icon name={name} />);
			const svg = view.container.querySelector("svg");
			expect(svg, name).not.toBeNull();
			expect(svg?.getAttribute("aria-hidden")).toBe("true");
			expect(svg?.childElementCount, name).toBeGreaterThan(0);
			await view.unmount();
		}
	});
});
