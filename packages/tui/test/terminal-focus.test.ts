import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessTerminal } from "../src/terminal.ts";

test("focus sequences update the focus state and notify listeners", () => {
	const terminal = new ProcessTerminal();
	assert.equal(terminal.isFocused(), undefined);

	const seen: boolean[] = [];
	const unsubscribe = terminal.onFocusChange((focused) => seen.push(focused));

	assert.equal(terminal.handleFocusSequence("\x1b[I"), true);
	assert.equal(terminal.isFocused(), true);
	assert.equal(terminal.handleFocusSequence("\x1b[O"), true);
	assert.equal(terminal.isFocused(), false);
	// Same state again: no duplicate listener fire.
	assert.equal(terminal.handleFocusSequence("\x1b[O"), true);

	unsubscribe();
	assert.equal(terminal.handleFocusSequence("\x1b[I"), true);
	assert.equal(terminal.isFocused(), true);

	assert.deepEqual(seen, [true, false]);
});

test("non-focus sequences are not handled", () => {
	const terminal = new ProcessTerminal();
	assert.equal(terminal.handleFocusSequence("\x1b[A"), false);
	assert.equal(terminal.handleFocusSequence("\x1b[200~"), false);
	assert.equal(terminal.handleFocusSequence("x"), false);
	assert.equal(terminal.isFocused(), undefined);
});
