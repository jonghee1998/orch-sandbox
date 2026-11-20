import test from "node:test";
import assert from "node:assert/strict";
import { wordCount, charCount, topWords } from "../src/text.mjs";

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

test("topWords", () => {
  assert.deepEqual(topWords("b a B, c a b", 2), [
    { word: "b", count: 3 },
    { word: "a", count: 2 },
  ]);
  // ties sorted alphabetically, default n = 3
  assert.deepEqual(topWords("d c b a"), [
    { word: "a", count: 1 },
    { word: "b", count: 1 },
    { word: "c", count: 1 },
  ]);
  assert.deepEqual(topWords(""), []);
  assert.deepEqual(topWords("a b", 0), []);
  assert.deepEqual(topWords("a b", -1), []);
  assert.deepEqual(topWords("a b", 1.5), []);
  assert.deepEqual(topWords(null), []);
});
