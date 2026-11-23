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
