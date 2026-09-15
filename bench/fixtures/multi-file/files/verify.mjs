import assert from "node:assert/strict";
import { total } from "./invoice.mjs";
assert.equal(total([{ price: 10, quantity: "1.5" }], 0), 15);
assert.equal(total([{ price: 10, quantity: "2" }]), 24);
console.log("verified");
