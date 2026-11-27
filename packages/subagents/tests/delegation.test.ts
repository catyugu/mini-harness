import test from 'node:test';
import assert from 'node:assert/strict';
import { requireChildDepth, selectChildModel } from '../src/server/delegation.ts';

test('model-chosen provider overrides registered defaults', () => {
  const defaults = { provider: 'openai', id: 'gpt-x' };
  const parent = { provider: 'anthropic', id: 'claude' };
  const models = () => [{ provider: 'custom', id: 'first' }];
  assert.deepEqual(selectChildModel({}, defaults, parent, models), { provider: 'openai', id: 'gpt-x' });
  assert.deepEqual(selectChildModel({ provider: 'custom', model: 'fast' }, defaults, parent, models), {
    provider: 'custom',
    id: 'fast',
  });
  assert.equal(selectChildModel({}, null, parent, models).provider, 'anthropic');
  assert.deepEqual(selectChildModel({ provider: 'custom' }, defaults, parent, models), models()[0]);
});

test('child spawning is limited to one level', () => {
  assert.doesNotThrow(() => requireChildDepth(0));
  assert.throws(() => requireChildDepth(1), /Recursive/);
});
