import { test } from "node:test";
import assert from "node:assert/strict";
import { fibonacci } from "./fib.js";

test("fibonacci basics", () => {
	assert.equal(fibonacci(0), 0);
	assert.equal(fibonacci(1), 1);
	assert.equal(fibonacci(2), 1);
	assert.equal(fibonacci(10), 55);
});
