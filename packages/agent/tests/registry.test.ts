import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../registry.js';
import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('concurrent scope preparation shares work and releases a failed reservation', async () => {
  const registry = new AgentRegistry();
  let calls = 0;
  const prepare = async () => { calls++; throw new Error('setup failed'); };
  const result = await Promise.allSettled([registry.prepare('one', prepare), registry.prepare('one', prepare)]);
  assert.equal(calls, 1);
  assert.ok(result.every(({ status }) => status === 'rejected'));
  assert.equal(registry.hasPending, false);
  await registry.prepare('one', async () => { calls++; });
  assert.equal(calls, 2);
});

test('a conversation has one active owner and returns to idle after cancellation', async (t) => {
  let release: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const { app, mock } = await fixture(t, async () => { await held; return 'done'; });
  const item = app.runtime.registry.create();
  const run = app.runtime.plugins.ctx.harnessRuns.send(item.id, 'hold');
  const cancelled = assert.rejects(run, /cancelled/);
  await waitUntil(() => mock.requests.length, (count) => count > 0);
  await assert.rejects(app.runtime.plugins.ctx.harnessRuns.send(item.id, 'duplicate'), /already running/);
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 1);
  app.runtime.plugins.ctx.harnessRuns.cancel(item.id);
  await cancelled;
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 0);
  assert.equal(app.runtime.plugins.ctx.harnessAgent.hasPending, false);
});
