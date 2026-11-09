import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const row = stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.find((line) => line.startsWith("→"));
	return row?.replace(/^→\s*(✓\s*)?/, "").split(" ")[0];
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (name: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(name))
				?.trimEnd();

		expect(getModelRow("Current Model")).toContain(`→ ✓ Current Model`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("Current Model")).toContain(`  ✓ Current Model`);
		selector.dispose();
	});

	// #5916
	it("shows model names that differ from the ID", async () => {
		harness = await createHarness({
			models: [
				{ id: "minimax/minimax-m3", name: "MiniMax M3 [parasail]" },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			],
		});
		const provider = harness.getModel("minimax/minimax-m3")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		// hummin rows show the human name in place of the id when they differ (the id stays searchable),
		// in SettingsList columns: label, then "context · provider".
		const rows = stripAnsi(selector.render(120).join("\n")).split("\n");
		expect(
			rows.some((row) => new RegExp(`MiniMax M3 \\[parasail\\]\\s+128K · ${provider}$`).test(row.trimEnd())),
		).toBe(true);
		expect(rows.some((row) => new RegExp(`Claude Sonnet 4\\.5\\s+128K · ${provider}$`).test(row.trimEnd()))).toBe(
			true,
		);
		selector.dispose();
	});

	it("moves by one page with remapped selection page keys (#7629)", async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.pageUp": "alt+v", "tui.select.pageDown": "ctrl+v" }));
		harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({ id: `model-${String(index).padStart(2, "0")}` })),
		});
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);

		selector.handleInput("\x16"); // Ctrl+V
		selector.handleInput("\x16");
		selector.handleInput("\x1bv"); // Alt+V
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "model-01" }));
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("selects a visible model by click", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("current-model"),
			harness.session.modelRuntime,
			[{ model: harness.getModel("current-model")! }, { model: harness.getModel("browsed-model")! }],
			select,
			() => {},
		);
		const rendered = selector.render(120);
		const row = rendered.findIndex((line) => stripAnsi(line).includes("Browsed Model"));
		expect(row).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y: row,
			screenX: 2,
			screenY: row,
			width: 120,
			height: rendered.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};

		expect(selector.handleMouse(event)?.handled).toBe(true);
		expect(select).toHaveBeenCalledWith(harness.getModel("browsed-model"));
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	// #9109
	describe("when the catalog refresh lands", () => {
		// Opens the selector with the refresh in flight, so a test can browse first and then let it land.
		async function openWithPendingRefresh(): Promise<{
			activeHarness: Harness;
			selector: ModelSelectorComponent;
			finishRefresh: () => Promise<void>;
		}> {
			const activeHarness = await createHarness({
				models: [{ id: "alpha-1" }, { id: "alpha-2" }, { id: "alpha-3" }, { id: "beta-1" }],
			});
			harness = activeHarness;
			const { promise, resolve } = Promise.withResolvers<ModelsRefreshResult>();
			vi.spyOn(activeHarness.session.modelRuntime, "refresh").mockReturnValue(promise);
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				activeHarness.getModel("alpha-1"),
				activeHarness.session.modelRuntime,
				[],
				() => {},
				() => {},
			);
			const finishRefresh = async () => {
				resolve({ aborted: false, errors: new Map() });
				await vi.waitFor(() => {
					expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
				});
			};
			return { activeHarness, selector, finishRefresh };
		}

		it("keeps the selection on the browsed model", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-3");
			selector.dispose();
		});

		it("keeps the selection while a search query is active", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			for (const char of "alpha") selector.handleInput(char);
			selector.handleInput("\x1b[B");
			const browsed = selectedModelId(selector);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe(browsed);
			expect(browsed).not.toBe("alpha-1");
			selector.dispose();
		});

		it("follows the selected model when new rows shift its position", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const snapshot = modelRuntime.getAvailableSnapshot();
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([
				{ ...snapshot[0], id: "added-model" },
				...snapshot,
			]);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-2");
			selector.handleInput("\x1b[A");
			selector.handleInput("\x1b[A");
			expect(selectedModelId(selector)).toBe("alpha-1");
			selector.dispose();
		});

		it("falls back to the current model when the selected model disappears", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const remaining = modelRuntime.getAvailableSnapshot().filter((model) => model.id !== "alpha-2");
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(remaining);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-1");
			selector.dispose();
		});
	});
});
