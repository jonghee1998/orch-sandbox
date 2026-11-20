import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean, median } from '../src/stats.mjs';

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

test('median handles odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median returns null for empty or non-array input', () => {
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

test('median throws TypeError for invalid elements', () => {
  assert.throws(() => median([1, 'a']), TypeError);
  assert.throws(() => median([1, NaN]), TypeError);
  assert.throws(() => median([1, Infinity]), TypeError);
});

test('median does not mutate the input array', () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});
