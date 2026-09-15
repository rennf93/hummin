import assert from "node:assert/strict";
import { format, draftPrefix } from "./formatter.mjs";
assert.equal(format(0), "0");
assert.equal(format(null), "missing");
assert.equal(draftPrefix, "WIP: ");
