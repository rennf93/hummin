import { type VimMode, type VimTextState, vimTransition } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

const st = (lines: string[], cursorLine: number, cursorCol: number): VimTextState => ({ lines, cursorLine, cursorCol });

const INSERT: VimMode = "INSERT";
const NORMAL: VimMode = "NORMAL";

function apply(mode: VimMode, key: string, state: VimTextState, pending: string | null = null) {
	return vimTransition(mode, key, state, pending);
}

describe("vimTransition mode switches", () => {
	it("starts in INSERT: escape switches to NORMAL", () => {
		const res = apply(INSERT, "escape", st(["foo"], 0, 2));
		expect(res.handled).toBe(true);
		expect(res.mode).toBe("NORMAL");
		expect(res.cursorCol).toBe(1); // vim backs the cursor off one
	});

	it("INSERT printable keys fall through to default handling", () => {
		const res = apply(INSERT, "x", st(["foo"], 0, 0));
		expect(res.handled).toBe(false);
	});

	it("i/a enter INSERT", () => {
		expect(apply(NORMAL, "i", st(["foo"], 0, 1)).mode).toBe("INSERT");
		const a = apply(NORMAL, "a", st(["foo"], 0, 1));
		expect(a.mode).toBe("INSERT");
		expect(a.cursorCol).toBe(2);
		// a at end of line clamps
		const aEnd = apply(NORMAL, "a", st(["foo"], 0, 3));
		expect(aEnd.mode).toBe("INSERT");
		expect(aEnd.cursorCol).toBe(3);
	});

	it("o opens a new line below and enters INSERT", () => {
		const res = apply(NORMAL, "o", st(["foo"], 0, 1));
		expect(res.mode).toBe("INSERT");
		expect(res.lines).toEqual(["foo", ""]);
		expect(res.cursorLine).toBe(1);
		expect(res.cursorCol).toBe(0);
		expect(res.edited).toBe(true);
	});
});

describe("vimTransition motions", () => {
	it("h/l move within a line", () => {
		const l = apply(NORMAL, "l", st(["foo"], 0, 0));
		expect(l.cursorCol).toBe(1);
		const h = apply(NORMAL, "h", st(["foo"], 0, 2));
		expect(h.cursorCol).toBe(1);
		// h at col 0 stays
		expect(apply(NORMAL, "h", st(["foo"], 0, 0)).cursorCol).toBe(0);
	});

	it("j/k move between lines, keeping column clamped", () => {
		const res = apply(NORMAL, "j", st(["long line", "ab"], 0, 5));
		expect(res.cursorLine).toBe(1);
		expect(res.cursorCol).toBe(2);
		const up = apply(NORMAL, "k", st(["long line", "ab"], 1, 1));
		expect(up.cursorLine).toBe(0);
		expect(up.cursorCol).toBe(1);
		// k at first line stays
		expect(apply(NORMAL, "k", st(["a"], 0, 0)).cursorLine).toBe(0);
	});

	it("0 and $ move to line start/end", () => {
		expect(apply(NORMAL, "0", st(["foo"], 0, 2)).cursorCol).toBe(0);
		expect(apply(NORMAL, "$", st(["foo"], 0, 0)).cursorCol).toBe(2);
	});

	it("w b e move by words", () => {
		const w = apply(NORMAL, "w", st(["foo bar"], 0, 0));
		expect(w.cursorCol).toBe(4);
		const e = apply(NORMAL, "e", st(["foo bar"], 0, 0));
		expect(e.cursorCol).toBe(6);
		const b = apply(NORMAL, "b", st(["foo bar"], 0, 4));
		expect(b.cursorCol).toBe(0);
	});

	it("gg and G jump to first/last line", () => {
		const g = apply(NORMAL, "g", st(["a", "b", "c"], 2, 0), null);
		expect(g.pending).toBe("g");
		const gg = apply(NORMAL, "g", st(["a", "b", "c"], 2, 0), "g");
		expect(gg.cursorLine).toBe(0);
		expect(gg.cursorCol).toBe(0);
		const G = apply(NORMAL, "G", st(["a", "b", "c"], 0, 0));
		expect(G.cursorLine).toBe(2);
	});
});

describe("vimTransition edits", () => {
	it("x deletes the char under the cursor and yanks it", () => {
		const res = apply(NORMAL, "x", st(["abc"], 0, 1));
		expect(res.lines).toEqual(["ac"]);
		expect(res.yanked).toBe("b");
		expect(res.edited).toBe(true);
	});

	it("dw deletes to end of word", () => {
		const res = apply(NORMAL, "w", st(["foo bar"], 0, 0), "d");
		expect(res.lines).toEqual(["bar"]);
		expect(res.yanked).toBe("foo ");
	});

	it("dd deletes the whole line linewise", () => {
		const res = apply(NORMAL, "d", st(["one", "two", "three"], 1, 1), "d");
		expect(res.lines).toEqual(["one", "three"]);
		expect(res.yanked).toBe("two");
		expect(res.yankLinewise).toBe(true);
		expect(res.cursorLine).toBe(1);
	});

	it("dd on the only line empties it", () => {
		const res = apply(NORMAL, "d", st(["only"], 0, 2), "d");
		expect(res.lines).toEqual([""]);
	});

	it("c behaves like d and enters INSERT", () => {
		const res = apply(NORMAL, "w", st(["foo bar"], 0, 0), "c");
		expect(res.lines).toEqual(["bar"]);
		expect(res.mode).toBe("INSERT");
	});

	it("cc empties the line and enters INSERT", () => {
		const res = apply(NORMAL, "c", st(["hello"], 0, 2), "c");
		expect(res.lines).toEqual([""]);
		expect(res.mode).toBe("INSERT");
	});

	it("unknown motion after operator cancels pending without editing", () => {
		const res = apply(NORMAL, "q", st(["abc"], 0, 0), "d");
		expect(res.mode).toBe("NORMAL");
		expect(res.pending).toBeNull();
		expect(res.lines).toEqual(["abc"]);
	});

	it("p signals put (editor inserts from the kill ring)", () => {
		const res = apply(NORMAL, "p", st(["abc"], 0, 0));
		expect(res.put).toBe(true);
	});

	it("u signals undo (editor uses its undo stack)", () => {
		const res = apply(NORMAL, "u", st(["abc"], 0, 0));
		expect(res.undo).toBe(true);
		expect(res.lines).toEqual(["abc"]);
	});
});

describe("default-mode passthrough", () => {
	it("vim layer is inert for control keys it does not own", () => {
		// Non-printable, non-vim key sequences fall through in NORMAL mode.
		const res = apply(NORMAL, "ctrl+z", st(["abc"], 0, 0));
		expect(res.handled).toBe(false);
	});

	it("insert-mode passthrough covers multi-char paste data", () => {
		expect(apply(INSERT, "\x1b[200~pasted", st([""], 0, 0)).handled).toBe(false);
	});
});
