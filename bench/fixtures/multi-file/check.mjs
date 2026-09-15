import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { total } = require(join(process.cwd(), "invoice.mjs"));
assert.equal(total([{ price: 8, quantity: "2.5" }], 0), 20);
assert.equal(total([{ price: 10, quantity: "2" }], 0.1), 22);
assert.equal(total([], 0), 0);
console.log("PASS: fractional quantities and explicit zero tax");
