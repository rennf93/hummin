import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MouseRecorder implements Component {
	readonly events: TuiMouseEvent[] = [];
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		this.events.push(event);
		return { handled: true, capture: event.type === "press" };
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

async function renderAndReportCursor(tui: TuiMainScreen, terminal: RecordingTerminal): Promise<void> {
	tui.renderNow();
	await terminal.flush();
	assert.ok(
		terminal.writes.some((write) => write.includes("\x1b[6n")),
		"expected a cursor position query",
	);
	const cursor = terminal.getCursorPosition();
	terminal.sendInput(`\x1b[${cursor.y + 1};${cursor.x + 1}R`);
}

function click(terminal: RecordingTerminal, x: number, y: number): void {
	terminal.sendInput(`\x1b[<0;${x + 1};${y + 1}M`);
	terminal.sendInput(`\x1b[<0;${x + 1};${y + 1}m`);
}

describe("TuiMainScreen mouse dispatch", () => {
	it("maps physical clicks from a nonzero initial cursor row to logical component rows", async () => {
		const terminal = new RecordingTerminal(30, 10);
		terminal.write("\x1b[5;1H");
		await terminal.flush();
		terminal.writes.length = 0;
		const tui = new TuiMainScreen(terminal, false, undefined, { mouse: true });
		const component = new MouseRecorder(["zero", "one", "two"]);
		tui.addChild(component);
		tui.start();
		try {
			await renderAndReportCursor(tui, terminal);
			click(terminal, 3, 5);

			assert.deepStrictEqual(
				component.events.map(({ type, x, y, screenY }) => ({ type, x, y, screenY })),
				[
					{ type: "press", x: 3, y: 1, screenY: 5 },
					{ type: "release", x: 3, y: 1, screenY: 5 },
					{ type: "click", x: 3, y: 1, screenY: 5 },
				],
			);
		} finally {
			tui.stop();
		}
	});

	it("maps clicks after content scrolls above the viewport", async () => {
		const terminal = new RecordingTerminal(30, 5);
		terminal.write("\x1b[3;1H");
		await terminal.flush();
		terminal.writes.length = 0;
		const tui = new TuiMainScreen(terminal, false, undefined, { mouse: true });
		const component = new MouseRecorder(Array.from({ length: 8 }, (_, index) => `line ${index}`));
		tui.addChild(component);
		tui.start();
		try {
			await renderAndReportCursor(tui, terminal);
			click(terminal, 0, 1);

			assert.equal(component.events[0]?.y, 4);
			assert.equal(component.events[2]?.y, 4);
		} finally {
			tui.stop();
		}
	});

	it("dispatches overlays before content and refreshes the coordinate map after resize", async () => {
		const terminal = new RecordingTerminal(30, 8);
		const tui = new TuiMainScreen(terminal, false, undefined, { mouse: true });
		const content = new MouseRecorder(["content"]);
		const overlay = new MouseRecorder(["overlay"]);
		tui.addChild(content);
		tui.showOverlay(overlay, { row: 2, col: 4, width: 10 });
		tui.start();
		try {
			await renderAndReportCursor(tui, terminal);
			click(terminal, 5, 2);
			assert.equal(overlay.events[0]?.y, 0);
			assert.equal(content.events.length, 0);

			terminal.resize(30, 6);
			await terminal.waitForRender();
			const cursor = terminal.getCursorPosition();
			terminal.sendInput(`\x1b[${cursor.y + 1};${cursor.x + 1}R`);
			click(terminal, 5, 2);
			assert.equal(overlay.events.filter((event) => event.type === "click").length, 2);
		} finally {
			tui.stop();
		}
	});

	it("enables application mouse reporting only when requested and restores it on stop", () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal, false, undefined, { mouse: true });
		tui.start();
		assert.ok(terminal.writes.some((write) => write.includes("\x1b[?1002h")));
		tui.stop();
		assert.ok(terminal.writes.some((write) => write.includes("\x1b[?1002l")));
		const plainTerminal = new RecordingTerminal();
		const plainTui = new TuiMainScreen(plainTerminal);
		plainTui.start();
		plainTui.stop();
		assert.ok(!plainTerminal.writes.some((write) => write.includes("\x1b[?1002h")));
	});

	it("cancels a pending click when streaming content shifts its row", async () => {
		const terminal = new RecordingTerminal(30, 10);
		const tui = new TuiMainScreen(terminal, false, undefined, { mouse: true });
		const lines = ["one", "two"];
		const component = new MouseRecorder(lines);
		tui.addChild(component);
		tui.start();
		try {
			await renderAndReportCursor(tui, terminal);
			terminal.sendInput("\x1b[<0;1;2M");
			lines.unshift("new line");
			await renderAndReportCursor(tui, terminal);
			terminal.sendInput("\x1b[<0;1;2m");
			assert.equal(component.events.filter((event) => event.type === "click").length, 0);
			click(terminal, 0, 2);
			assert.equal(component.events.filter((event) => event.type === "click").length, 1);
		} finally {
			tui.stop();
		}
	});
});
