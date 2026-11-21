import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('model-check first line starts with "model: claude-"', () => {
  const text = readFileSync(new URL('../docs/model-check.md', import.meta.url), 'utf8');
  assert.ok(text.split('\n')[0].startsWith('model: claude-'));
});
