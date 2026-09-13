import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkArray } from "./util.js";

test("chunks of exact size", () => {
	assert.deepEqual(chunkArray([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
});
test("no reordering, no loss", () => {
	const chunks = chunkArray([..."abcdefgh"], 4);
	assert.deepEqual(chunks.flat(), [..."abcdefgh"]);
});
