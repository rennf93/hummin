/**
 * stats.test: the hummin-specific console chrome. Covers the fleet and
 * activity reducer cases (including snapshot replacement and the failed
 * activity lifecycle), the number formatters, the header's tok/s, auto label,
 * cost, todo chip and activity status word, the session stats popover (rows,
 * omission, Escape), the rail fleet section, and the all-absent case where
 * none of the new elements render.
 */
/// <reference lib="dom" />
import { act } from "react";
import { describe, expect, it } from "vitest";
import { Header, headerStatus, headerStatusShort } from "./components/Header.tsx";
import { HostRail } from "./components/HostRail.tsx";
import { clampedPlacement, formatCompactNumber, formatCost } from "./components/StatsPopover.tsx";
import type {
	AnyRemoteEvent,
	RemoteEventPayloadMap,
	RemoteEventType,
	SnapshotPayload,
	WireFleetServer,
	WireStats,
	WireStatus,
} from "./harness/replay-log.ts";
import { mount } from "./renderer/test/mount.tsx";
import { type HostState, type HostStore, initialHostState, reduceHosts } from "./store.ts";

function makeEvent<K extends RemoteEventType>(type: K, seq: number, payload: RemoteEventPayloadMap[K]): AnyRemoteEvent {
	// The type/payload correlation holds by construction: the payload is typed from the same key.
	return { v: 1, seq, ts: "2026-01-01T00:00:00.000Z", type, payload } as AnyRemoteEvent;
}

const SERVERS: WireFleetServer[] = [
	{
		id: "llamacpp-fleet-a.test-8080",
		engine: "llamacpp",
		host: "fleet-a.test",
		port: 8080,
		discovery: "fresh",
		models: ["demo-coder-30b"],
		active: true,
	},
	{
		id: "colibri-fleet-b.test-8081",
		engine: "colibri",
		host: "fleet-b.test",
		port: 8081,
		discovery: "stale",
		models: [],
		active: false,
	},
];

const FULL_STATUS: WireStatus = {
	kind: "working",
	model: { provider: "llamacpp", modelId: "demo-coder-30b" },
	thinkingLevel: "medium",
	contextUsage: { tokens: 40_000, contextWindow: 131072, percent: 31 },
	stats: {
		tokens: { input: 1_500_000, output: 266_000, cacheRead: 40_000_000, cacheWrite: 1000 },
		cacheHitPercent: 99.3,
		costUsd: 1.554,
		tokensPerSecond: 112.4,
		diff: { added: 850, removed: 148 },
		todos: { done: 3, total: 6 },
	},
	workspace: { cwd: "/home/demo/projects/console", repo: "console", branch: "main" },
	autoCompact: true,
	version: "1.10.2",
};

function hostState(overrides: Partial<HostState> = {}): HostState {
	return { ...initialHostState("demo", "demo://local"), connection: "connected", ...overrides };
}

function renderHeader(state: HostState, appearanceOpen = false) {
	return (
		<Header
			state={state}
			preset="studio"
			onPreset={() => undefined}
			onOpenAppearance={() => undefined}
			appearanceOpen={appearanceOpen}
		/>
	);
}

describe("stats: formatters", () => {
	it("formats compact counts", () => {
		expect(formatCompactNumber(999)).toBe("999");
		expect(formatCompactNumber(1499)).toBe("1.5k");
		expect(formatCompactNumber(266_000)).toBe("266k");
		expect(formatCompactNumber(1_500_000)).toBe("1.5M");
		expect(formatCompactNumber(40_000_000)).toBe("40M");
	});

	it("rolls compact counts over to the next unit instead of printing 1000k or 1000M", () => {
		expect(formatCompactNumber(999_950)).toBe("1M");
		expect(formatCompactNumber(999_999)).toBe("1M");
		expect(formatCompactNumber(999_950_000)).toBe("1B");
		expect(formatCompactNumber(999.6)).toBe("1k");
		expect(formatCompactNumber(999_499)).toBe("999k");
	});

	it("returns a dash for NaN, negative and non-finite counts", () => {
		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(formatCompactNumber(bad)).toBe("-");
			expect(formatCost(bad)).toBe("-");
		}
	});

	it("shows near-one dollar as $1.00 and dust as <$0.001", () => {
		expect(formatCost(0.9996)).toBe("$1.00");
		expect(formatCost(1)).toBe("$1.00");
		expect(formatCost(0.0004)).toBe("<$0.001");
		expect(formatCost(0.001)).toBe("$0.001");
		// An exact zero is a real "no spend", not dust.
		expect(formatCost(0)).toBe("$0.00");
	});

	it("formats cost with two decimals from one dollar and three below", () => {
		expect(formatCost(1.554)).toBe("$1.55");
		expect(formatCost(0.0421)).toBe("$0.042");
	});
});

describe("stats: reducer fleet and activity", () => {
	const SNAPSHOT: SnapshotPayload = {
		host: { origin: "demo://local", label: "demo" },
		protocolVersion: 1,
		sessionId: "s1",
		sessionName: "one",
		status: { kind: "idle", model: null },
		messages: [],
		holds: [],
		queue: { items: [], terminalQueued: 0 },
	};

	function ensured(): HostStore {
		return reduceHosts({}, { type: "ensure", hostId: "h1", label: "lab", origin: "demo://local" });
	}

	function apply(store: HostStore, event: AnyRemoteEvent): HostStore {
		return reduceHosts(store, { type: "event", hostId: "h1", event, receivedAt: 1 });
	}

	it("starts empty and takes fleet from the snapshot, defaulting to none", () => {
		let store = ensured();
		expect(store.h1?.fleet).toEqual([]);
		expect(store.h1?.activity).toBeNull();
		store = apply(store, makeEvent("snapshot", 0, { ...SNAPSHOT, fleet: SERVERS }));
		expect(store.h1?.fleet).toEqual(SERVERS);
		store = apply(store, makeEvent("snapshot", 1, SNAPSHOT));
		expect(store.h1?.fleet).toEqual([]);
	});

	it("replaces the fleet on a fleet event", () => {
		let store = apply(ensured(), makeEvent("snapshot", 0, { ...SNAPSHOT, fleet: SERVERS }));
		store = apply(store, makeEvent("fleet", 1, { servers: SERVERS.slice(1) }));
		expect(store.h1?.fleet.map((server) => server.id)).toEqual(["colibri-fleet-b.test-8081"]);
	});

	it("sets activity on start and clears it on end", () => {
		let store = apply(ensured(), makeEvent("activity", 0, { activity: { kind: "compaction", phase: "start" } }));
		expect(store.h1?.activity).toEqual({ kind: "compaction", phase: "start" });
		store = apply(store, makeEvent("activity", 1, { activity: { kind: "compaction", phase: "end" } }));
		expect(store.h1?.activity).toBeNull();
	});

	it("keeps a failed activity until the run works again or a new activity starts", () => {
		let store = apply(ensured(), makeEvent("activity", 0, { activity: { kind: "memory_fold", phase: "failed" } }));
		store = apply(store, makeEvent("status", 1, { status: { kind: "idle", model: null } }));
		expect(store.h1?.activity?.phase).toBe("failed");
		const worked = apply(store, makeEvent("status", 2, { status: { kind: "working", model: null } }));
		expect(worked.h1?.activity).toBeNull();
		const restarted = apply(store, makeEvent("activity", 2, { activity: { kind: "compaction", phase: "start" } }));
		expect(restarted.h1?.activity).toEqual({ kind: "compaction", phase: "start" });
	});

	it("clears activity on a snapshot", () => {
		let store = apply(ensured(), makeEvent("activity", 0, { activity: { kind: "compaction", phase: "start" } }));
		store = apply(store, makeEvent("snapshot", 1, SNAPSHOT));
		expect(store.h1?.activity).toBeNull();
	});
});

describe("stats: header", () => {
	it("shows tok/s, auto label, cost and todo chip when published", async () => {
		const mounted = await mount(renderHeader(hostState({ status: FULL_STATUS })));
		try {
			expect(document.querySelector("[data-rc-tps]")?.getAttribute("data-rc-tps")).toBe("112");
			expect(document.querySelector("[data-rc-tps]")?.textContent).toContain("tok/s");
			expect(document.querySelector("[data-rc-autocompact]")?.textContent).toBe("auto");
			expect(document.querySelector("[data-rc-cost] .rc-header-metric-visual")?.textContent).toBe("$1.55");
			expect(document.querySelector("[data-rc-cost] .rc-sr-only")?.textContent).toBe("session cost $1.55");
			expect(document.querySelector("[data-rc-todos] .rc-header-metric-visual")?.textContent).toBe("3/6");
			expect(document.querySelector("[data-rc-todos] .rc-sr-only")?.textContent).toBe("todos 3 of 6 done");
			expect(document.querySelector("[data-rc-ctx] .rc-sr-only")?.textContent).toBe(
				"context usage 31 percent, auto-compact on",
			);
		} finally {
			await mounted.unmount();
		}
	});

	it("omits tok/s while idle (null), cost below 3 decimals rule holds, hides empty todos", async () => {
		const status: WireStatus = {
			...FULL_STATUS,
			autoCompact: false,
			stats: { tokensPerSecond: null, costUsd: 0.0421, todos: { done: 0, total: 0 } },
		};
		const mounted = await mount(renderHeader(hostState({ status })));
		try {
			expect(document.querySelector("[data-rc-tps]")).toBeNull();
			expect(document.querySelector("[data-rc-autocompact]")).toBeNull();
			expect(document.querySelector("[data-rc-cost] .rc-header-metric-visual")?.textContent).toBe("$0.042");
			expect(document.querySelector("[data-rc-todos]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("dims the remembered tok/s when nothing streams", async () => {
		const status: WireStatus = { ...FULL_STATUS, stats: { tokensPerSecond: null } };
		const mounted = await mount(renderHeader(hostState({ status, lastTokensPerSecond: 87.2 })));
		try {
			const tps = document.querySelector("[data-rc-tps]");
			expect(tps?.getAttribute("data-rc-tps")).toBe("87");
			expect(tps?.getAttribute("data-rc-tps-stale")).toBe("true");
			expect(tps?.querySelector(".rc-sr-only")?.textContent).toBe("last measured 87 tokens per second");
			expect(tps?.querySelector(".rc-header-metric-visual")?.getAttribute("aria-hidden")).toBe("true");
		} finally {
			await mounted.unmount();
		}
	});

	it("shows the activity label in place of the run status, and the failed form", async () => {
		const mounted = await mount(
			renderHeader(hostState({ status: FULL_STATUS, activity: { kind: "compaction", phase: "start" } })),
		);
		try {
			const word = () => document.querySelector(".rc-header-status-word");
			expect(word()?.textContent).toBe("Compacting");
			await mounted.render(
				renderHeader(hostState({ status: FULL_STATUS, activity: { kind: "memory_fold", phase: "start" } })),
			);
			expect(word()?.textContent).toBe("Folding memory");
			await mounted.render(
				renderHeader(hostState({ status: FULL_STATUS, activity: { kind: "memory_fold", phase: "failed" } })),
			);
			expect(word()?.textContent).toBe("Memory fold failed");
			expect(word()?.querySelector(".rc-icon")).not.toBeNull();
			await mounted.render(
				renderHeader(hostState({ status: FULL_STATUS, activity: { kind: "compaction", phase: "failed" } })),
			);
			expect(word()?.textContent).toBe("Compaction failed");
			await mounted.render(renderHeader(hostState({ status: FULL_STATUS })));
			expect(word()?.textContent).toBe("working");
		} finally {
			await mounted.unmount();
		}
	});

	it("opens the stats popover with present rows only and closes on Escape", async () => {
		const status: WireStatus = {
			kind: "idle",
			model: null,
			stats: { cacheHitPercent: 99.3, diff: { added: 850, removed: 148 } },
			version: "1.10.2",
		};
		const mounted = await mount(renderHeader(hostState({ status })));
		try {
			const button = document.querySelector<HTMLButtonElement>("[data-rc-stats-open]");
			expect(button?.getAttribute("aria-expanded")).toBe("false");
			expect(document.querySelector("[data-rc-stats]")).toBeNull();
			await act(async () => button?.click());
			const dialog = document.querySelector("[data-rc-stats]");
			expect(dialog?.getAttribute("role")).toBe("dialog");
			expect(dialog?.getAttribute("aria-label")).toBe("session stats");
			expect(button?.getAttribute("aria-expanded")).toBe("true");
			const rows = [...document.querySelectorAll("[data-rc-stats-row]")].map((row) =>
				row.getAttribute("data-rc-stats-row"),
			);
			expect(rows).toEqual(["cache-hit", "changes", "version"]);
			expect(document.querySelector('[data-rc-stats-row="changes"]')?.textContent).toContain("+850");
			expect(document.querySelector('[data-rc-stats-row="changes"]')?.textContent).toContain("-148");
			await act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			});
			expect(document.querySelector("[data-rc-stats]")).toBeNull();
			expect(button?.getAttribute("aria-expanded")).toBe("false");
		} finally {
			await mounted.unmount();
		}
	});

	it("omits the Todos row at zero total, omits missing token parts, shows cache write when above zero", async () => {
		const status: WireStatus = {
			kind: "idle",
			model: null,
			// The wire type says every field is present; the host may still omit one.
			stats: {
				tokens: { input: 1200, output: Number.NaN, cacheWrite: 2500 } as WireStats["tokens"],
				todos: { done: 0, total: 0 },
			},
		};
		const mounted = await mount(renderHeader(hostState({ status })));
		try {
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-stats-open]")?.click());
			expect(document.querySelector('[data-rc-stats-row="todos"]')).toBeNull();
			const tokens = document.querySelector('[data-rc-stats-row="tokens"] .rc-stats-value')?.textContent;
			expect(tokens).toBe("in 1.2k / cache write 2.5k");
			expect(tokens).not.toContain("NaN");
		} finally {
			await mounted.unmount();
		}
	});

	it("closes on an outside pointerdown, when focus leaves, and when the appearance panel opens", async () => {
		const status: WireStatus = { kind: "idle", model: null, version: "1.10.2" };
		const mounted = await mount(renderHeader(hostState({ status })));
		const dialog = () => document.querySelector("[data-rc-stats]");
		const open = async () => {
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-stats-open]")?.click());
			expect(dialog()).not.toBeNull();
		};
		try {
			await open();
			await act(async () => {
				dialog()?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			});
			expect(dialog()).not.toBeNull();
			await act(async () => {
				document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			});
			expect(dialog()).toBeNull();

			await open();
			const outside = document.createElement("button");
			document.body.appendChild(outside);
			await act(async () => outside.focus());
			expect(dialog()).toBeNull();
			outside.remove();

			await open();
			await mounted.render(renderHeader(hostState({ status }), true));
			expect(dialog()).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("returns focus to the button when Tab leaves the popover", async () => {
		const status: WireStatus = { kind: "idle", model: null, version: "1.10.2" };
		const mounted = await mount(renderHeader(hostState({ status })));
		try {
			const button = document.querySelector<HTMLButtonElement>("[data-rc-stats-open]");
			await act(async () => button?.click());
			const dialog = document.querySelector("[data-rc-stats]");
			expect(document.activeElement).toBe(dialog);
			const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
			await act(async () => {
				dialog?.dispatchEvent(tab);
			});
			expect(tab.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(button);
			expect(document.querySelector("[data-rc-stats]")).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("places the popover inside the viewport with an 8px margin", async () => {
		const original = window.innerWidth;
		const status: WireStatus = { kind: "idle", model: null, version: "1.10.2" };
		const mounted = await mount(renderHeader(hostState({ status })));
		try {
			window.innerWidth = 390;
			const anchor = document.querySelector<HTMLElement>(".rc-stats-anchor");
			if (anchor === null) throw new Error("anchor missing");
			anchor.getBoundingClientRect = () => ({ right: 20, bottom: 40 }) as DOMRect;
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-stats-open]")?.click());
			const dialog = document.querySelector<HTMLElement>("[data-rc-stats]");
			expect(dialog?.style.left).toBe("8px");
			expect(dialog?.style.top).toBe("46px");
			// Anchor moves: recomputed on resize.
			anchor.getBoundingClientRect = () => ({ right: 380, bottom: 40 }) as DOMRect;
			await act(async () => {
				window.dispatchEvent(new Event("resize"));
			});
			expect(dialog?.style.left).toBe("8px");
		} finally {
			window.innerWidth = original;
			await mounted.unmount();
		}
	});

	it("clamps placement at both viewport edges and never exceeds the viewport", () => {
		// Wide viewport, anchor near the right: right-aligned to the anchor.
		expect(clampedPlacement({ right: 1400, bottom: 50 }, 416, 1440)).toEqual({ top: 56, left: 984 });
		// Anchor past the right edge: pinned 8px from it.
		expect(clampedPlacement({ right: 1500, bottom: 50 }, 416, 1440).left).toBe(1016);
		// Anchor near the left edge: pinned 8px from it.
		expect(clampedPlacement({ right: 20, bottom: 50 }, 358, 390).left).toBe(8);
		// Unmeasured (width 0) at 390: fallback width is viewport minus 16.
		expect(clampedPlacement({ right: 380, bottom: 50 }, 0, 390).left).toBe(8);
	});

	it("lists every row for a full status", async () => {
		const mounted = await mount(renderHeader(hostState({ status: FULL_STATUS })));
		try {
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-stats-open]")?.click());
			const rows = [...document.querySelectorAll("[data-rc-stats-row]")].map((row) =>
				row.getAttribute("data-rc-stats-row"),
			);
			expect(rows).toEqual([
				"workspace",
				"model",
				"tokens",
				"cache-hit",
				"cost",
				"speed",
				"context",
				"changes",
				"todos",
				"version",
			]);
			expect(document.querySelector('[data-rc-stats-row="tokens"]')?.textContent).toContain("cache write 1k");
			expect(document.querySelector('[data-rc-stats-row="tokens"]')?.textContent).toContain("1.5M");
			expect(document.querySelector('[data-rc-stats-row="tokens"]')?.textContent).toContain("266k");
			expect(document.querySelector('[data-rc-stats-row="tokens"]')?.textContent).toContain("40M");
			expect(document.querySelector('[data-rc-stats-row="context"]')?.textContent).toContain("auto-compact on");
		} finally {
			await mounted.unmount();
		}
	});

	it("names the connection state, not the last run status, when the stream is down", async () => {
		for (const connection of ["connecting", "reconnecting", "unreachable", "unauthorized", "closed"] as const) {
			expect(headerStatus(hostState({ status: FULL_STATUS, connection }))).toBe(connection);
		}
		expect(headerStatus(hostState({ status: FULL_STATUS }))).toBe("working");
		const state = hostState({
			status: FULL_STATUS,
			connection: "reconnecting",
			lastTokensPerSecond: 50,
			activity: { kind: "compaction", phase: "start" },
		});
		const mounted = await mount(renderHeader(state));
		try {
			const word = document.querySelector(".rc-header-status-word");
			expect(word?.textContent).toBe("reconnecting");
			expect(document.querySelector(".rc-shimmer")).toBeNull();
			expect(word?.getAttribute("data-rc-activity")).toBeNull();
			expect(document.querySelector("[data-rc-status-dot]")?.getAttribute("data-rc-status-dot")).toBe(
				"reconnecting",
			);
			expect(document.querySelector("[data-rc-tps]")).toBeNull();
			expect(document.querySelector("[data-rc-ctx]")?.getAttribute("data-rc-stale")).toBe("true");
			expect(document.querySelector("[data-rc-cost]")?.getAttribute("data-rc-stale")).toBe("true");
		} finally {
			await mounted.unmount();
		}
	});

	it("reflects the appearance panel in aria-expanded", async () => {
		const mounted = await mount(renderHeader(hostState({ status: FULL_STATUS })));
		try {
			const button = () => document.querySelector("[data-rc-appearance-open]");
			expect(button()?.getAttribute("aria-expanded")).toBe("false");
			await mounted.render(renderHeader(hostState({ status: FULL_STATUS }), true));
			expect(button()?.getAttribute("aria-expanded")).toBe("true");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders none of the new elements when nothing is published", async () => {
		const status: WireStatus = {
			kind: "idle",
			model: { provider: "a", modelId: "b" },
			contextUsage: { tokens: 1, contextWindow: 10, percent: 10 },
		};
		const mounted = await mount(renderHeader(hostState({ status })));
		try {
			for (const hook of ["tps", "autocompact", "cost", "todos", "stats-open", "activity"]) {
				expect(document.querySelector(`[data-rc-${hook}]`)).toBeNull();
			}
			expect(document.querySelector("[data-rc-ctx]")).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});

describe("stats: add-host form", () => {
	const noop = () => undefined;
	function renderRail(hosts: { id: string; label: string; origin: string; token: string }[], onAdd = noop) {
		return (
			<HostRail
				hosts={hosts}
				states={{}}
				activeId={null}
				originWarnings={{}}
				onSelect={noop}
				onAdd={onAdd}
				onRemove={noop}
			/>
		);
	}

	function type(input: HTMLInputElement | null, value: string) {
		if (input === null) throw new Error("input missing");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	it("sets mobile-friendly input attributes", async () => {
		const mounted = await mount(renderRail([]));
		try {
			const [label, origin, token] = ["label", "origin", "token"].map((name) =>
				document.querySelector<HTMLInputElement>(`[data-rc-add-${name}]`),
			);
			for (const input of [label, origin, token]) {
				expect(input?.getAttribute("autocapitalize")).toBe("off");
				expect(input?.getAttribute("autocorrect")).toBe("off");
				expect(input?.getAttribute("spellcheck")).toBe("false");
			}
			expect(origin?.getAttribute("type")).toBe("url");
			expect(origin?.getAttribute("inputmode")).toBe("url");
			expect(token?.getAttribute("type")).toBe("password");
			expect(token?.getAttribute("autocomplete")).toBe("off");
		} finally {
			await mounted.unmount();
		}
	});

	it("clears the error when any field is edited", async () => {
		const mounted = await mount(
			renderRail([], () => {
				throw new Error("bad origin");
			}),
		);
		try {
			const origin = document.querySelector<HTMLInputElement>("[data-rc-add-origin]");
			await act(async () => {
				type(origin, "nope");
				type(document.querySelector<HTMLInputElement>("[data-rc-add-token]"), "t");
			});
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-add-submit]")?.click());
			expect(document.querySelector(".rc-add-error")?.textContent).toBe("bad origin");
			await act(async () => type(document.querySelector<HTMLInputElement>("[data-rc-add-label]"), "x"));
			expect(document.querySelector(".rc-add-error")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("focuses the first field when the user opens the form, not on the initial onboarding mount", async () => {
		const host = [{ id: "h1", label: "main", origin: "demo://local", token: "t" }];
		const onboarding = await mount(renderRail([]));
		try {
			expect(document.activeElement).not.toBe(document.querySelector("[data-rc-add-label]"));
		} finally {
			await onboarding.unmount();
		}
		const mounted = await mount(renderRail(host));
		try {
			expect(document.querySelector("[data-rc-add-label]")).toBeNull();
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-add-toggle]")?.click());
			expect(document.activeElement).toBe(document.querySelector("[data-rc-add-label]"));
		} finally {
			await mounted.unmount();
		}
	});

	it("points aria-controls at an element that exists while expanded", async () => {
		const mounted = await mount(renderRail([{ id: "h1", label: "main", origin: "demo://local", token: "t" }]));
		try {
			const toggle = document.querySelector<HTMLButtonElement>("[data-rc-add-toggle]");
			expect(toggle?.getAttribute("aria-controls")).toBeNull();
			await act(async () => toggle?.click());
			const controls = toggle?.getAttribute("aria-controls");
			expect(controls).toBeTruthy();
			expect(document.getElementById(controls ?? "")?.classList.contains("rc-add-fields")).toBe(true);
		} finally {
			await mounted.unmount();
		}
	});

	it("renders the active host's hints once on the strip line, separate from the chip", async () => {
		const mounted = await mount(
			<HostRail
				hosts={[{ id: "h1", label: "main", origin: "demo://local", token: "t" }]}
				states={{ h1: hostState({ connection: "unauthorized" }) }}
				activeId="h1"
				originWarnings={{ h1: "boom" }}
				onSelect={noop}
				onAdd={noop}
				onRemove={noop}
			/>,
		);
		try {
			expect(document.querySelectorAll('[data-rc-strip-hint="auth"]')).toHaveLength(1);
			expect(document.querySelector('[data-rc-strip-hint="origin"]')?.textContent).toContain("boom");
			expect(document.querySelectorAll("[data-rc-auth-hint]")).toHaveLength(1);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("stats: rail fleet", () => {
	const HOSTS = [{ id: "h1", label: "main", origin: "demo://local", token: "t" }];

	function renderRail(fleet: WireFleetServer[]) {
		return (
			<HostRail
				hosts={HOSTS}
				states={{ h1: hostState({ fleet }) }}
				activeId="h1"
				originWarnings={{}}
				onSelect={() => undefined}
				onAdd={() => undefined}
				onRemove={() => undefined}
			/>
		);
	}

	it("lists servers with the in-use label on the active one", async () => {
		const mounted = await mount(renderRail(SERVERS));
		try {
			expect(document.querySelector("[data-rc-fleet]")).not.toBeNull();
			const active = document.querySelector('[data-rc-fleet-server="llamacpp-fleet-a.test-8080"]');
			expect(active?.textContent).toContain("demo-coder-30b");
			expect(active?.textContent).toContain("fleet-a.test:8080");
			expect(active?.textContent).toContain("in use");
			const down = document.querySelector('[data-rc-fleet-server="colibri-fleet-b.test-8081"]');
			// No models: the server id names the row.
			expect(down?.textContent).toContain("colibri-fleet-b.test-8081");
			expect(down?.textContent).not.toContain("in use");
			expect(down?.textContent).toContain("stale");
			expect(document.querySelectorAll("[data-rc-fleet] button")).toHaveLength(0);
		} finally {
			await mounted.unmount();
		}
	});

	it("labels a server with no discovery record as not discovered", async () => {
		const undiscovered: WireFleetServer = {
			id: "llamacpp-fleet-c.test-8082",
			engine: "llamacpp",
			host: "fleet-c.test",
			port: 8082,
			discovery: "none",
			models: [],
			active: false,
		};
		const mounted = await mount(renderRail([undiscovered]));
		try {
			const row = document.querySelector('[data-rc-fleet-server="llamacpp-fleet-c.test-8082"]');
			expect(row?.textContent).toContain("not discovered");
			expect(row?.textContent).not.toContain("in use");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders no fleet section for an empty list", async () => {
		const mounted = await mount(renderRail([]));
		try {
			expect(document.querySelector("[data-rc-fleet]")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});
});

describe("stats: session identity and status", () => {
	const noop = () => undefined;
	const HOST = { id: "h1", label: "studio-mac", origin: "demo://local", token: "t" };
	const FULL_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

	function renderRail(state: HostState, onRemove: (id: string) => void = noop) {
		return (
			<HostRail
				hosts={[HOST]}
				states={{ h1: state }}
				activeId="h1"
				originWarnings={{}}
				onSelect={noop}
				onAdd={noop}
				onRemove={onRemove}
			/>
		);
	}

	function visibleText(root: Element | null): string {
		const clone = root?.cloneNode(true) as Element;
		for (const hidden of clone.querySelectorAll(".rc-sr-only")) hidden.remove();
		return clone.textContent ?? "";
	}

	it("rail row leads with the session name, then host label and short id, and never shows 'connected'", async () => {
		const mounted = await mount(renderRail(hostState({ sessionName: "my session", sessionId: FULL_ID })));
		try {
			const row = document.querySelector('[data-rc-host-row="h1"]');
			expect(document.querySelector(".rc-host-label")?.textContent).toBe("my session");
			expect(document.querySelector('[data-rc-host-sub="connected"]')?.textContent).toContain("studio-mac");
			expect(document.querySelector(".rc-session-id")?.textContent).toBe("0198a1b2");
			expect(visibleText(row)).not.toContain("connected");
			expect(row?.querySelector(".rc-sr-only")?.textContent).toBe("connected");
		} finally {
			await mounted.unmount();
		}
	});

	it("falls back to the host label as the name and renders no id when there is none", async () => {
		const mounted = await mount(renderRail(hostState({ sessionName: null, sessionId: null })));
		try {
			expect(document.querySelector(".rc-host-label")?.textContent).toBe("studio-mac");
			expect(document.querySelector(".rc-session-id")).toBeNull();
			expect(document.querySelector('[data-rc-host-sub="connected"]')).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("shows the state word instead of the id when not connected", async () => {
		const mounted = await mount(
			renderRail(hostState({ connection: "reconnecting", sessionName: "my session", sessionId: FULL_ID })),
		);
		try {
			expect(document.querySelector('[data-rc-host-sub="reconnecting"]')?.textContent).toBe("reconnecting");
			expect(document.querySelector(".rc-session-id")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("header shows the session name and id, and no visible 'connected' without a run status", async () => {
		const mounted = await mount(
			renderHeader(hostState({ sessionName: "my session", sessionId: FULL_ID, status: null })),
		);
		try {
			expect(document.querySelector(".rc-header-title")?.textContent).toBe("my session");
			expect(document.querySelector(".rc-header-identity .rc-session-id")?.textContent).toBe("0198a1b2");
			expect(visibleText(document.querySelector(".rc-header-status-word"))).toBe("");
			expect(document.querySelector(".rc-header-status-word .rc-sr-only")?.textContent).toBe("connected");
		} finally {
			await mounted.unmount();
		}
	});

	it("gives the status a short label for narrow headers, and never a different meaning", async () => {
		const waiting = hostState({ status: { kind: "waiting", detail: "approval", model: null } });
		expect(headerStatus(waiting)).toBe("waiting: approval");
		expect(headerStatusShort(waiting)).toBe("approval");
		expect(headerStatusShort(hostState({ status: FULL_STATUS }))).toBe("working");
		expect(headerStatusShort(hostState({ connection: "unreachable" }))).toBe("unreachable");
		const mounted = await mount(renderHeader(waiting));
		try {
			expect(document.querySelector(".rc-status-full")?.textContent).toBe("waiting: approval");
			expect(document.querySelector(".rc-status-short")?.textContent).toBe("approval");
		} finally {
			await mounted.unmount();
		}
	});

	it("asks before removing a host; Cancel and Escape restore focus to the X", async () => {
		const removed: string[] = [];
		const mounted = await mount(renderRail(hostState(), (id) => removed.push(id)));
		try {
			const remove = () => document.querySelector<HTMLButtonElement>("[data-rc-remove]");
			await act(async () => remove()?.click());
			expect(removed).toEqual([]);
			expect(document.querySelector("[data-rc-remove-confirm]")?.textContent).toContain("Remove studio-mac?");
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-remove-cancel]")?.click());
			expect(document.querySelector("[data-rc-remove-confirm]")).toBeNull();
			expect(document.activeElement).toBe(remove());
			await act(async () => remove()?.click());
			await act(async () => {
				document
					.querySelector("[data-rc-remove-confirm]")
					?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			});
			expect(document.querySelector("[data-rc-remove-confirm]")).toBeNull();
			expect(document.activeElement).toBe(remove());
			expect(removed).toEqual([]);
			await act(async () => remove()?.click());
			await act(async () => document.querySelector<HTMLButtonElement>("[data-rc-remove-confirm-yes]")?.click());
			expect(removed).toEqual(["h1"]);
		} finally {
			await mounted.unmount();
		}
	});
});
