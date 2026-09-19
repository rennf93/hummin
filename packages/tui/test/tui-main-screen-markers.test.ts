import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FixedComponent implements Component {
	private readonly lines: string[];
	readonly scrollbarMarkerKind: string | undefined;
	readonly scrollbarMarkerAnchor: "top" | "bottom" | undefined;

	constructor(lines: string[], scrollbarMarkerKind?: string, scrollbarMarkerAnchor?: "top" | "bottom") {
		this.lines = lines;
		this.scrollbarMarkerKind = scrollbarMarkerKind;
		this.scrollbarMarkerAnchor = scrollbarMarkerAnchor;
	}
	render(): string[] {
		return this.lines;
	}

	handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return undefined;
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

const identityStyles: Record<string, (text: string) => string> = {
	user: (text) => text,
	system: (text) => text,
	turnEnd: (text) => text,
};

function buildTranscript(): Container {
	const transcript = new Container();
	transcript.addChild(new FixedComponent(["user line"], "user"));
	const filler = new FixedComponent(Array.from({ length: 8 }, (_, i) => `filler ${i}`));
	transcript.addChild(filler);
	transcript.addChild(new FixedComponent(["assistant line"], "turnEnd", "bottom"));
	return transcript;
}

async function firstRender(width: number, height: number, styles?: Record<string, (text: string) => string>) {
	const terminal = new RecordingTerminal(width, height);
	const tui = new TuiMainScreen(terminal, false, undefined, { scrollbarMarkerStyles: styles ?? identityStyles });
	tui.addChild(buildTranscript());
	tui.start();
	tui.renderNow();
	await terminal.flush();
	return { terminal, tui };
}

describe("regular-mode scrollbar markers", () => {
	it("collects marker rows from nested containers, anchoring bottom markers to the last row", () => {
		const transcript = buildTranscript();
		transcript.render(20);
		assert.deepStrictEqual(transcript.renderMarkers, [
			{ row: 0, kind: "user" },
			{ row: 9, kind: "turnEnd" },
		]);
	});

	it("paints marker glyphs in the last column of the marked rows", async () => {
		const { terminal, tui } = await firstRender(20, 10);
		try {
			const output = terminal.writes.join("");
			const userLine = output.split("\n").find((line) => line.includes("user line"));
			const assistantLine = output.split("\n").find((line) => line.includes("assistant line"));
			assert.ok(userLine, "user line was rendered");
			assert.ok(assistantLine, "assistant line was rendered");
			assert.ok(userLine.includes("▌"), `user marker painted: ${JSON.stringify(userLine)}`);
			assert.ok(assistantLine.includes("●"), `turnEnd marker painted: ${JSON.stringify(assistantLine)}`);
		} finally {
			tui.stop();
		}
	});

	it("does not paint markers without configured styles", async () => {
		const { terminal, tui } = await firstRender(20, 10, {});
		try {
			const output = terminal.writes.join("");
			assert.ok(output.includes("user line"));
			assert.ok(!output.includes("▌"), "no user glyph without a style");
			assert.ok(!output.includes("●"), "no turnEnd glyph without a style");
		} finally {
			tui.stop();
		}
	});

	it("only paints markers for rows inside the viewport", async () => {
		// 10 content rows in a 4-row terminal: only the last 4 rows (rows 6-9) are in the
		// viewport, so the turnEnd marker (row 9) is painted and the user marker (row 0) is not.
		const { terminal, tui } = await firstRender(20, 4);
		try {
			const output = terminal.writes.join("");
			const lines = output.split("\n");
			const assistantLine = lines.find((line) => line.includes("assistant line"));
			assert.ok(assistantLine, "assistant line was rendered");
			assert.ok(assistantLine.includes("●"), `turnEnd marker painted: ${JSON.stringify(assistantLine)}`);
			const userLine = lines.find((line) => line.includes("user line"));
			assert.ok(userLine, "user line was rendered");
			assert.ok(!userLine.includes("▌"), `user marker above viewport stays unpainted: ${JSON.stringify(userLine)}`);
		} finally {
			tui.stop();
		}
	});
});
