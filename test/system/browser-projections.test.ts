import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserProjections } from '@mini-harness/ui-runtime/projections';

test('browser invalidations reach only registered feature owners and dispose independently', async () => {
  const registry = new BrowserProjections();
  const seen: unknown[] = [];
  const first = registry.register('sessions', { sync: (...args) => { seen.push(['first', ...args]); } });
  const second = registry.register('sessions', { sync: (...args) => { seen.push(['second', ...args]); } });
  registry.register('settings', { sync: (...args) => { seen.push(['settings', ...args]); } });
  await registry.dispatch({ type: 'change', domain: 'sessions', revision: 3, sessionId: 'one' });
  assert.deepEqual(seen, [['first', 3, false, 'one'], ['second', 3, false, 'one']]);
  first();
  seen.length = 0;
  await registry.dispatch({ type: 'change', domain: 'sessions', revision: 4 });
  assert.deepEqual(seen, [['second', 4, false, undefined]]);
  second();
  seen.length = 0;
  await registry.dispatch({ type: 'snapshot', revisions: { sessions: 5, settings: 2, plugins: 0, models: 0, workspaces: 0, approvals: 0, files: 0, queue: 0 } });
  assert.deepEqual(seen, [['settings', 2, true, undefined]]);
});

test('a failing projection surfaces recovery while other owners still synchronize', async () => {
  const failures: string[] = [];
  const registry = new BrowserProjections((_domain, error) => { failures.push(String(error)); });
  let healthy = false;
  registry.register('plugins', { sync: () => { throw new Error('Refresh failed'); } });
  registry.register('plugins', { sync: async () => { healthy = true; } });
  await registry.dispatch({ type: 'change', domain: 'plugins', revision: 1 });
  await registry.dispatch({ type: 'change', domain: 'plugins', revision: 2 });
  assert.deepEqual(failures, ['Error: Refresh failed']);
  assert.equal(healthy, true);
});

test('disposing an owner cancels a queued invalidation before its fetch begins', async () => {
  const registry = new BrowserProjections();
  let calls = 0;
  const release = registry.register('models', { sync: () => { calls++; } });
  const pending = registry.dispatch({ type: 'change', domain: 'models', revision: 1 });
  release();
  await pending;
  assert.equal(calls, 0);
});
