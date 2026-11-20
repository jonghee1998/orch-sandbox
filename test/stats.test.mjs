import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean } from '../src/stats.mjs';

test('mean computes the average', () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test('mean returns null for empty or non-array input', () => {
  assert.equal(mean([]), null);
  assert.equal(mean(null), null);
  assert.equal(mean('abc'), null);
});

test('mean throws TypeError for invalid elements', () => {
  assert.throws(() => mean([1, 'a']), TypeError);
  assert.throws(() => mean([1, NaN]), TypeError);
  assert.throws(() => mean([1, Infinity]), TypeError);
});
