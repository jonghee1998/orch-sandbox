import test from "node:test";
import assert from "node:assert/strict";
import { wordCount } from "../src/text.mjs";

test("wordCount", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("  hello   world "), 2);
  assert.equal(wordCount(null), 0);
});
