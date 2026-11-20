import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength } from '../src/auth/password.mjs';

test('non-strings and empty score 0', () => {
  assert.equal(passwordStrength(''), 0);
  assert.equal(passwordStrength(null), 0);
  assert.equal(passwordStrength(123), 0);
});

test('scores each criterion', () => {
  assert.equal(passwordStrength('Abcdef1!'), 5);
  assert.equal(passwordStrength('abcdefgh'), 2);
  assert.equal(passwordStrength('ABC'), 1);
  assert.equal(passwordStrength('a1'), 2);
});
