/// <reference lib="dom" />
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireApproval } from "../harness/replay-log.ts";
import { mount } from "../renderer/test/mount.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";

const hold = (id = "a1"): WireApproval => ({
	id,
	toolName: "bash",
	argsPreview: "ls",
	deadlineMs: Date.now() + 60_000,
	createdAt: "t",
});
const ok = () => Promise.resolve({ ok: true, status: 202 });

describe("approval card", () => {
	beforeEach(() => document.documentElement.style.setProperty("--rc-duration-exit", "160ms"));
	afterEach(() => {
		document.documentElement.style.removeProperty("--rc-duration-exit");
		vi.useRealTimers();
	});

	it("shows the chip, the mono tool name and 'wants to run'", async () => {
		const mounted = await mount(<ApprovalCard holds={[hold()]} onResolve={ok} />);
		try {
			const title = document.querySelector(".rc-approval-title");
			expect(title?.textContent).toBe("approvalbash wants to run");
			expect(title?.querySelector("code")?.textContent).toBe("bash");
		} finally {
			await mounted.unmount();
		}
	});

	it("marks only the clicked button busy while its POST is in flight", async () => {
		let finish: (r: { ok: boolean; status: number }) => void = () => undefined;
		const onResolve = vi.fn(
			() =>
				new Promise<{ ok: boolean; status: number }>((r) => {
					finish = r;
				}),
		);
		const mounted = await mount(<ApprovalCard holds={[hold()]} onResolve={onResolve} />);
		try {
			await act(async () => document.querySelector<HTMLButtonElement>('[data-rc-deny="a1"]')?.click());
			expect(document.querySelector('[data-rc-deny="a1"]')?.getAttribute("aria-busy")).toBe("true");
			expect(document.querySelector('[data-rc-approve="a1"]')?.getAttribute("aria-busy")).toBeNull();
			await act(async () => document.querySelector<HTMLButtonElement>('[data-rc-approve="a1"]')?.click());
			expect(onResolve).toHaveBeenCalledTimes(1);
			await act(async () => finish({ ok: false, status: 0 }));
			expect(document.querySelector('[data-rc-deny="a1"]')?.getAttribute("aria-busy")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps a resolved card mounted for the exit duration, then unmounts it", async () => {
		vi.useFakeTimers();
		const mounted = await mount(<ApprovalCard holds={[hold()]} onResolve={ok} />);
		try {
			await mounted.render(<ApprovalCard holds={[]} onResolve={ok} />);
			expect(document.querySelector("[data-rc-approval]")?.getAttribute("data-state")).toBe("closed");
			await act(async () => vi.advanceTimersByTime(100));
			expect(document.querySelector("[data-rc-approval]")).not.toBeNull();
			await act(async () => vi.advanceTimersByTime(100));
			expect(document.querySelector("[data-rc-approval]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});
