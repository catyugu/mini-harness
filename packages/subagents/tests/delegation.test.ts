import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, requireChildDepth, selectChildModel } from '../src/server/delegation.js';

test('model-chosen provider overrides registered defaults', () => {
  const defaults = { provider: 'openai', id: 'gpt-x' };
  const parent = { provider: 'anthropic', id: 'claude' };
  assert.deepEqual(selectChildModel({}, defaults, parent), { provider: 'openai', id: 'gpt-x' });
  assert.deepEqual(selectChildModel({ provider: 'custom', model: 'fast' }, defaults, parent), { provider: 'custom', id: 'fast' });
  assert.equal(selectChildModel({}, null, parent).provider, 'anthropic');
});

test('child spawning is limited to one level', () => {
  assert.doesNotThrow(() => requireChildDepth(0));
  assert.throws(() => requireChildDepth(1), /Recursive/);
});

test('semaphore caps concurrency and releases on errors', async () => {
  const sem = new Semaphore(2);
  let active = 0, peak = 0;
  const outputs = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const lease = await sem.lease();
    try {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (i === 2) throw new Error('expected');
      return i;
    } catch { return 'error'; }
    finally { lease.release(); }
  }));
  assert.equal(peak, 2);
  assert.equal(outputs[2], 'error');
  assert.equal(sem.active, 0);
});
