import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/strings.mjs';

test('slugify basic', () => {
  assert.equal(slugify('Hello, World 2026!'), 'hello-world-2026');
});

test('slugify trims and collapses hyphens', () => {
  assert.equal(slugify('  --a--b--  '), 'a-b');
});

test('slugify returns empty string for non-strings', () => {
  assert.equal(slugify(null), '');
  assert.equal(slugify(42), '');
  assert.equal(slugify(undefined), '');
});
