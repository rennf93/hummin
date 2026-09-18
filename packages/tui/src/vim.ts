/**
 * Pure vim modal-editing layer for the Editor component.
 *
 * All logic lives in `vimTransition`, a pure function from
 * (mode, key, text state, pending operator) to a new state plus effects.
 * The Editor applies the effects (undo snapshot, kill ring push, put, undo)
 * so this module stays free of editor internals.
 */

export type VimMode = "INSERT" | "NORMAL";

/** Plain text state the transition operates on (mirrors the editor's cursor state). */
export interface VimTextState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

export interface VimTransitionResult {
	/** False means "not a vim key" - the caller falls through to default handling. */
	handled: boolean;
	mode: VimMode;
	lines: string[];
	cursorLine: number;
	cursorCol: number;
	/** True when text or cursor moved as an edit (caller should snapshot undo first). */
	edited?: boolean;
	/** Text produced by a delete/yank operation (caller pushes to the kill ring). */
	yanked?: string;
	/** True when `yanked` is a whole line (put inserts it as a line below). */
	yankLinewise?: boolean;
	/** True for `p` - caller inserts the kill ring's most recent entry. */
	put?: boolean;
	/** True for `u` - caller triggers its undo stack. */
	undo?: boolean;
	/** Pending operator awaiting a motion ("d", "c", "y") or "g" for gg. */
	pending: string | null;
}

function clampCol(line: string, col: number): number {
	return Math.max(0, Math.min(col, line.length));
}

function result(
	mode: VimMode,
	state: VimTextState,
	pending: string | null,
	extra?: Partial<VimTransitionResult>,
): VimTransitionResult {
	return {
		handled: true,
		mode,
		lines: state.lines,
		cursorLine: state.cursorLine,
		cursorCol: state.cursorCol,
		pending,
		...extra,
	};
}

/** Move forward one word (w): start of next word, crossing line boundaries. */
function wordForward(state: VimTextState): void {
	const line = state.lines[state.cursorLine] || "";
	const col = findWordForwardInLine(line, state.cursorCol);
	if (col > state.cursorCol) {
		state.cursorCol = col;
		return;
	}
	if (state.cursorLine < state.lines.length - 1) {
		state.cursorLine++;
		state.cursorCol = 0;
		const next = state.lines[state.cursorLine] || "";
		state.cursorCol = findWordForwardInLine(next, 0);
	}
}

function findWordForwardInLine(line: string, from: number): number {
	const isWs = (ch: string) => /\s/.test(ch);
	const isWordChar = (ch: string) => /[\w]/.test(ch);
	let i = from;
	if (i < line.length && !isWs(line[i]!)) {
		// Skip the current run (word chars or punctuation), then whitespace.
		if (isWordChar(line[i]!)) {
			while (i < line.length && isWordChar(line[i]!)) i++;
		} else {
			while (i < line.length && !isWordChar(line[i]!) && !isWs(line[i]!)) i++;
		}
	}
	while (i < line.length && isWs(line[i]!)) i++;
	return i;
}

/** Move backward one word (b): start of previous word, crossing line boundaries. */
function wordBackward(state: VimTextState): void {
	const line = state.lines[state.cursorLine] || "";
	if (state.cursorCol > 0) {
		let i = state.cursorCol;
		const isWs = (ch: string) => /\s/.test(ch);
		const isWordChar = (ch: string) => /[\w]/.test(ch);
		while (i > 0 && isWs(line[i - 1]!)) i--;
		if (i > 0 && isWordChar(line[i - 1]!)) {
			while (i > 0 && isWordChar(line[i - 1]!)) i--;
		} else {
			while (i > 0 && !isWordChar(line[i - 1]!) && !isWs(line[i - 1]!)) i--;
		}
		state.cursorCol = i;
		return;
	}
	if (state.cursorLine > 0) {
		state.cursorLine--;
		const prev = state.lines[state.cursorLine] || "";
		state.cursorCol = prev.length;
		wordBackward(state);
	}
}

/** Move to end of word (e), crossing line boundaries. */
function wordEnd(state: VimTextState): void {
	const isWordChar = (ch: string) => /[\w]/.test(ch);
	let line = state.lines[state.cursorLine] || "";
	let col = state.cursorCol;
	// Step forward to next word char, crossing lines as needed.
	for (;;) {
		if (col < line.length && !isWordChar(line[col]!)) {
			col++;
			continue;
		}
		if (col < line.length && col !== state.cursorCol) break;
		if (col < line.length && col === state.cursorCol) {
			// Currently ON a word char: skip to its end, then look for next word.
			while (col < line.length && isWordChar(line[col]!)) col++;
			continue;
		}
		// Move to next line.
		if (state.cursorLine >= state.lines.length - 1) {
			state.cursorCol = clampCol(line, col);
			return;
		}
		state.cursorLine++;
		line = state.lines[state.cursorLine] || "";
		col = 0;
	}
	while (col + 1 < line.length && isWordChar(line[col + 1]!)) col++;
	state.cursorCol = col;
}

/** End position (line, col-exclusive) of word forward within the current line, for dw/cw. */
function wordForwardEndInLine(line: string, from: number): number {
	const isWordChar = (ch: string) => /[\w]/.test(ch);
	const isWs = (ch: string) => /\s/.test(ch);
	let i = from;
	while (i < line.length && isWs(line[i]!)) i++;
	if (i === from) {
		if (i < line.length && isWordChar(line[i]!)) {
			while (i < line.length && isWordChar(line[i]!)) i++;
		} else {
			while (i < line.length && !isWordChar(line[i]!) && !isWs(line[i]!)) i++;
		}
	}
	return i;
}

function clampState(state: VimTextState): void {
	state.cursorLine = Math.max(0, Math.min(state.cursorLine, state.lines.length - 1));
	const line = state.lines[state.cursorLine] || "";
	state.cursorCol = clampCol(line, state.cursorCol);
}

/** Handle a pending operator + motion combination. Returns null if the motion is unsupported. */
function applyOperator(
	op: string,
	motionKey: string,
	state: VimTextState,
): {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
	yanked?: string;
	yankLinewise?: boolean;
	enterInsert?: boolean;
} | null {
	const line = state.lines[state.cursorLine] || "";
	const lineOp = op === motionKey; // dd / cc / yy

	if (lineOp) {
		if (op === "y")
			return {
				lines: state.lines,
				cursorLine: state.cursorLine,
				cursorCol: state.cursorCol,
				yanked: line,
				yankLinewise: true,
			};
		const lines = state.lines.slice();
		let cursorLine = state.cursorLine;
		if (lines.length === 1) {
			lines[0] = "";
		} else {
			lines.splice(cursorLine, 1);
			cursorLine = Math.min(cursorLine, lines.length - 1);
		}
		const newCol = clampCol(lines[cursorLine] || "", 0);
		return { lines, cursorLine, cursorCol: newCol, yanked: line, yankLinewise: true, enterInsert: op === "c" };
	}

	// Ranges within the current line.
	let endCol: number;
	switch (motionKey) {
		case "w": {
			endCol = wordForwardEndInLine(line, state.cursorCol);
			if (endCol === state.cursorCol) endCol = line.length;
			// dw/cw include trailing whitespace after the word (vim behavior).
			while (endCol < line.length && /\s/.test(line[endCol]!)) endCol++;
			break;
		}
		case "$":
			endCol = line.length;
			break;
		case "0":
			return null; // 0 as motion end makes no sense; ignore
		default:
			return null; // b/e/h/l handled as multi-line motions elsewhere
	}
	if (endCol <= state.cursorCol) return null;
	const yanked = line.slice(state.cursorCol, endCol);
	const newLine = line.slice(0, state.cursorCol) + line.slice(endCol);
	const lines = state.lines.slice();
	lines[state.cursorLine] = newLine;
	return {
		lines,
		cursorLine: state.cursorLine,
		cursorCol: clampCol(newLine, state.cursorCol),
		yanked,
		enterInsert: op === "c",
	};
}

/**
 * Apply one vim key. `key` is a single printable character or a named key
 * ("escape", "enter", "up", "down", "left", "right"). In INSERT mode only
 * escape is vim-handled; everything else falls through to the editor's
 * default (insert) handling.
 */
export function vimTransition(
	mode: VimMode,
	key: string,
	input: VimTextState,
	pending: string | null,
): VimTransitionResult {
	if (mode === "INSERT") {
		if (key === "escape") {
			const state: VimTextState = { lines: input.lines, cursorLine: input.cursorLine, cursorCol: input.cursorCol };
			clampState(state);
			if (state.cursorCol > 0) state.cursorCol--;
			return result("NORMAL", state, null);
		}
		return {
			handled: false,
			mode,
			lines: input.lines,
			cursorLine: input.cursorLine,
			cursorCol: input.cursorCol,
			pending,
		};
	}

	// NORMAL mode
	const state: VimTextState = { lines: input.lines, cursorLine: input.cursorLine, cursorCol: input.cursorCol };
	const line = () => state.lines[state.cursorLine] || "";

	if (pending !== null) {
		// "g" waiting for "g"
		if (pending === "g") {
			if (key === "g") {
				state.cursorLine = 0;
				state.cursorCol = 0;
				return result("NORMAL", state, null, { edited: true });
			}
			return result("NORMAL", state, null);
		}
		// operator waiting for motion
		const op = pending;
		if (key === "escape") return result("NORMAL", state, null);
		if (key === "g") {
			// e.g. "dg" - wait for the final g of a dgg; unsupported: cancel
			return result("NORMAL", state, null);
		}
		const applied = applyOperator(op, key, state);
		if (!applied) return result("NORMAL", state, null);
		const enterInsert = applied.enterInsert === true;
		const extra: Partial<VimTransitionResult> = { edited: true };
		if (applied.yanked !== undefined) {
			extra.yanked = applied.yanked;
			extra.yankLinewise = applied.yankLinewise === true;
		}
		const res = result(
			enterInsert ? "INSERT" : "NORMAL",
			{ lines: applied.lines, cursorLine: applied.cursorLine, cursorCol: applied.cursorCol },
			null,
			extra,
		);
		return res;
	}

	switch (key) {
		case "escape":
			return result("NORMAL", state, null);
		case "i":
			return result("INSERT", state, null);
		case "a": {
			state.cursorCol = clampCol(line(), state.cursorCol + 1);
			return result("INSERT", state, null);
		}
		case "o": {
			const lines = state.lines.slice();
			lines.splice(state.cursorLine + 1, 0, "");
			return result("INSERT", { lines, cursorLine: state.cursorLine + 1, cursorCol: 0 }, null, { edited: true });
		}
		case "O": {
			const lines = state.lines.slice();
			lines.splice(state.cursorLine, 0, "");
			return result("INSERT", { lines, cursorLine: state.cursorLine, cursorCol: 0 }, null, { edited: true });
		}
		case "h":
		case "left": {
			if (state.cursorCol > 0) state.cursorCol--;
			else if (state.cursorLine > 0) {
				state.cursorLine--;
				state.cursorCol = (state.lines[state.cursorLine] || "").length;
			}
			return result("NORMAL", state, null, { edited: true });
		}
		case "l":
		case "right": {
			if (state.cursorCol < line().length) state.cursorCol++;
			else if (state.cursorLine < state.lines.length - 1) {
				state.cursorLine++;
				state.cursorCol = 0;
			}
			return result("NORMAL", state, null, { edited: true });
		}
		case "j":
		case "down": {
			if (state.cursorLine < state.lines.length - 1) {
				state.cursorLine++;
				state.cursorCol = clampCol(line(), state.cursorCol);
			}
			return result("NORMAL", state, null, { edited: true });
		}
		case "k":
		case "up": {
			if (state.cursorLine > 0) {
				state.cursorLine--;
				state.cursorCol = clampCol(line(), state.cursorCol);
			}
			return result("NORMAL", state, null, { edited: true });
		}
		case "0":
			state.cursorCol = 0;
			return result("NORMAL", state, null, { edited: true });
		case "$":
			state.cursorCol = Math.max(0, line().length - 1);
			return result("NORMAL", state, null, { edited: true });
		case "w":
			wordForward(state);
			return result("NORMAL", state, null, { edited: true });
		case "b":
			wordBackward(state);
			return result("NORMAL", state, null, { edited: true });
		case "e":
			wordEnd(state);
			return result("NORMAL", state, null, { edited: true });
		case "g":
			return result("NORMAL", state, "g");
		case "G":
			state.cursorLine = state.lines.length - 1;
			state.cursorCol = clampCol(line(), state.cursorCol);
			return result("NORMAL", state, null, { edited: true });
		case "x": {
			if (line().length === 0 || state.cursorCol >= line().length) return result("NORMAL", state, null);
			const yanked = line()[state.cursorCol]!;
			const lines = state.lines.slice();
			lines[state.cursorLine] = line().slice(0, state.cursorCol) + line().slice(state.cursorCol + 1);
			return result("NORMAL", { lines, cursorLine: state.cursorLine, cursorCol: state.cursorCol }, null, {
				edited: true,
				yanked,
			});
		}
		case "d":
		case "c":
		case "y":
			return result("NORMAL", state, key);
		case "p":
			return result("NORMAL", state, null, { put: true });
		case "u":
			return result("NORMAL", state, null, { undo: true });
		default:
			// Swallow unrecognized printable keys in normal mode; let control
			// sequences (paste, ctrl combos) fall through.
			if (key.length === 1) return result("NORMAL", state, null);
			return {
				handled: false,
				mode,
				lines: input.lines,
				cursorLine: input.cursorLine,
				cursorCol: input.cursorCol,
				pending,
			};
	}
}
