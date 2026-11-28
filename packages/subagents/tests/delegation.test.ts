import test from 'node:test';
import assert from 'node:assert/strict';
import { requireChildDepth, selectChildModel } from '../src/server/delegation.ts';

test('model-chosen provider overrides registered defaults', () => {
  const defaults = { provider: 'openai', id: 'gpt-x' };
  const parent = { provider: 'anthropic', id: 'claude' };
  assert.deepEqual(selectChildModel({}, defaults, parent), { provider: 'openai', id: 'gpt-x' });
  assert.deepEqual(selectChildModel({ provider: 'custom', model: 'fast' }, defaults, parent), {
    provider: 'custom',
    id: 'fast',
  });
  assert.equal(selectChildModel({}, null, parent).provider, 'anthropic');
  assert.deepEqual(selectChildModel({ provider: 'custom' }, defaults, parent), { provider: 'custom' });
});

test('child spawning is limited to one level', () => {
  assert.doesNotThrow(() => requireChildDepth(0));
  assert.throws(() => requireChildDepth(1), /Recursive/);
});
