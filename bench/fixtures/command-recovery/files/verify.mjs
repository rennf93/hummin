import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { normalize } from "./normalize.mjs";
assert.equal(normalize("  River  "), "river");
writeFileSync(".verified", "passed\n");
