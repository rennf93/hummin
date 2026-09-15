import assert from "node:assert/strict";
import test from "node:test";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";

const theme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

test("select list renders category headers within its height and maps mouse rows", () => {
	const selected: string[] = [];
	const list = new SelectList(
		[
			{ value: "plan", label: "plan", category: "Session" },
			{ value: "model", label: "model", category: "Models" },
			{ value: "fleet", label: "fleet", category: "Fleet" },
		],
		4,
		theme,
	);
	list.onSelect = (item) => selected.push(item.value);
	const lines = list.render(80);
	assert.deepEqual(lines.slice(0, 4), ["  Session", "→ plan", "  Models", "  model"]);
	list.handleMouse({
		type: "click",
		button: "left",
		x: 1,
		y: 3,
		screenX: 1,
		screenY: 3,
		width: 80,
		height: 4,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.deepEqual(selected, ["model"]);
});
