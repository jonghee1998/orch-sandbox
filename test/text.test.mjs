import test from "node:test";
import assert from "node:assert/strict";
import { wordCount, charCount } from "../src/text.mjs";

test("wordCount", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("  hello   world "), 2);
  assert.equal(wordCount(null), 0);
});

test("charCount", () => {
  assert.equal(charCount("abc"), 3);
  assert.equal(charCount("a b"), 3);
  assert.equal(charCount("a b", { ignoreSpaces: true }), 2);
  assert.equal(charCount(null), 0);
  assert.equal(charCount(undefined), 0);
  assert.equal(charCount(123), 0);
  assert.equal(charCount("한글😀"), 3);
});
