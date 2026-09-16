import { describe, expect, it } from "vitest";
import { findMarkerJumpTarget, type TranscriptMarker } from "../src/modes/interactive/interactive-mode.ts";

function markers(...contentRows: number[]): TranscriptMarker[] {
	return contentRows.map((contentRow, i) => ({ trackRow: i, contentRow, kind: "user" }));
}

describe("findMarkerJumpTarget", () => {
	it("returns undefined for empty markers", () => {
		expect(findMarkerJumpTarget([], 0, "previous")).toBeUndefined();
		expect(findMarkerJumpTarget([], 10, "next")).toBeUndefined();
	});

	it("jumps to largest contentRow strictly below scrollTop + 1 for previous", () => {
		expect(findMarkerJumpTarget(markers(0, 10, 20, 30), 21, "previous")).toBe(20);
		// scrollTop exactly on a marker row: per spec, previous is < scrollTop + 1,
		// so the row at scrollTop itself is a valid target
		expect(findMarkerJumpTarget(markers(0, 10, 20, 30), 20, "previous")).toBe(20);
	});

	it("jumps to smallest contentRow strictly above scrollTop for next", () => {
		expect(findMarkerJumpTarget(markers(0, 10, 20, 30), 10, "next")).toBe(20);
		expect(findMarkerJumpTarget(markers(0, 10, 20, 30), 11, "next")).toBe(20);
	});

	it("returns undefined when no target exists", () => {
		expect(findMarkerJumpTarget(markers(10, 20), 0, "previous")).toBeUndefined();
		expect(findMarkerJumpTarget(markers(10, 20), 20, "next")).toBeUndefined();
	});

	it("handles unsorted marker arrays", () => {
		expect(findMarkerJumpTarget(markers(30, 0, 20, 10), 15, "previous")).toBe(10);
		expect(findMarkerJumpTarget(markers(30, 0, 20, 10), 15, "next")).toBe(20);
	});
});
