import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('shell approval gates execution, handles rejection and cancellation', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) => messages.at(-1).role === 'tool' ? 'Tool completed' :
    { tool: 'sandbox_shell', args: { command: 'echo approved' } });
  await app.runtime.updateSettings({ plugins: { shell: true }, pluginConfig: { shell: { mode: 'host' } } });
  const { body: session } = await request('/sessions', 'POST', {});
  for (const allow of [false, true]) {
    await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Run a shell command' });
    const pending = await waitUntil(() => request('/approvals'), (r) => r.body.length > 0);
    assert.equal(pending.body[0].command, 'echo approved');
    assert.equal((await request('/approvals', 'POST', { id: pending.body[0].id, allow })).status, 200);
    await finish(session.id);
    const history = (await request('/sessions/' + session.id)).body.messages;
    const tool = history.filter((m) => m.role === 'toolResult').at(-1);
    assert.equal(tool.isError, !allow); assert.deepEqual(tool.arguments, { command: 'echo approved' });
    if (allow) {
      assert.match(JSON.stringify(tool.content), /approved/);
      assert.equal(tool.exitCode, 0);
      assert.ok(Number.isFinite(tool.elapsedMs) && tool.elapsedMs >= 0);
      app.runtime.pi.release(session.id);
      const restored = (await request('/sessions/' + session.id)).body.messages.filter((m) => m.role === 'toolResult').at(-1);
      assert.equal(restored.exitCode, 0);
      assert.ok(Number.isFinite(restored.elapsedMs) && restored.elapsedMs >= 0);
    }
  }
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Cancel pending approval' });
  await waitUntil(() => request('/approvals'), (r) => r.body.length > 0);
  await request('/sessions/' + session.id + '/cancel', 'POST', {}); await finish(session.id);
  assert.deepEqual((await request('/approvals')).body, []);
});

test('disabling Shell drains its pending approval and preserves an unrelated run', { timeout: 15000 }, async (t) => {
  let entered: () => void;
  let release: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { app, request, finish } = await fixture(t, async ({ messages }) => {
    const last = messages.at(-1);
    if (last.role === 'tool') return 'Shell request settled';
    if (last.content === 'Unrelated task') {
      entered();
      await held;
      return 'Unrelated task completed';
    }
    return { tool: 'sandbox_shell', args: { command: 'echo must-not-run' } };
  });
  await app.runtime.updateSettings({ plugins: { shell: true }, pluginConfig: { shell: { mode: 'host' } } });
  const shell = app.runtime.registry.create();
  const other = app.runtime.registry.create();
  const pending = app.runtime.runs.send(other.id, 'Unrelated task');
  try {
    await running;
    await request('/sessions/' + shell.id + '/runs', 'POST', { message: 'Run Shell' });
    await waitUntil(() => request('/approvals'), (result) => result.body.length === 1);
    assert.equal((await request('/settings', 'PATCH', { plugins: { shell: false } })).status, 200);
    assert.deepEqual((await request('/approvals')).body, []);
    const graph = (await request('/bootstrap')).body.ui;
    assert.ok(!graph.some(({ id }) => id === 'shell'));
    assert.ok(app.runtime.runs.active(other.id));
    assert.equal((await finish(shell.id)).body.run.state, 'completed');
    const tool = app.runtime.pi.messages(shell.id).find(({ role }) => role === 'toolResult');
    assert.equal(tool.isError, true);
    assert.ok(!(await app.runtime.pi.open(shell.id)).getActiveToolNames().includes('sandbox_shell'));
  } finally { release(); }
  assert.equal(await pending, 'Unrelated task completed');
});
