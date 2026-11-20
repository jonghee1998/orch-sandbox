import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleLabel } from '../src/roles.mjs';

test('roleLabel: 알려진 역할', () => {
  assert.equal(roleLabel('admin'), '관리자');
  assert.equal(roleLabel('editor'), '편집자');
  assert.equal(roleLabel('viewer'), '열람자');
});

test('roleLabel: 알 수 없는 값', () => {
  for (const v of ['guest', '', null, undefined, 1, {}, 'toString']) {
    assert.equal(roleLabel(v), '알 수 없음');
  }
});
