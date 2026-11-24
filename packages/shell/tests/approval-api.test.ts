import { expectPresent } from '../../../test/support/required.js';
import { defaultShellMode } from '../manifest.js';
import { supportsIsolation } from '@mini-harness/platform/isolation';
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('shell approval gates execution, handles rejection and cancellation', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) => messages.at(-1)?.role === 'tool' ? 'Tool completed' :
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
    const tool = history.filter((m: { role: string }) => m.role === 'toolResult').at(-1);
    assert.equal(tool.isError, !allow); assert.deepEqual(tool.arguments, { command: 'echo approved' });
    assert.ok(Number.isFinite(tool.approvalMs) && tool.approvalMs >= 0);
    if (!allow) { assert.equal(tool.approvalDenied, true); assert.equal(tool.elapsedMs, 0); }
    if (allow) {
      assert.match(JSON.stringify(tool.content), /approved/);
      assert.equal(tool.exitCode, 0);
      assert.ok(Number.isFinite(tool.elapsedMs) && tool.elapsedMs >= 0);
      const restored = (await request('/sessions/' + session.id)).body.messages.filter((m: { role: string }) => m.role === 'toolResult').at(-1);
      assert.equal(restored.exitCode, 0);
      assert.ok(Number.isFinite(restored.elapsedMs) && restored.elapsedMs >= 0);
    }
  }
  const other = (await request('/sessions', 'POST', {})).body;
  assert.equal(other.permission, 'standard');
  assert.equal((await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'readOnly' })).status, 200);
  assert.equal((await request('/sessions/' + session.id)).body.permission, 'readOnly');
  assert.equal((await request('/sessions/' + other.id)).body.permission, 'standard');
  const tools = app.runtime.plugins.ctx.harnessTools;
  assert.ok(tools.forSession(session.id).some(({ name }) => name === 'read'));
  assert.ok(!tools.forSession(session.id).some(({ name }) => name === 'sandbox_shell' || name === 'write'));
  assert.ok(tools.forSession(other.id).some(({ name }) => name === 'sandbox_shell'));
  assert.equal((await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'invalid' })).status, 400);
  assert.equal((await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'standard' })).status, 200);
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Permission changed while awaiting approval' });
  const pendingApproval = await waitUntil(() => request('/approvals'), (r) => r.body.length > 0);
  assert.equal((await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'readOnly' })).status, 200);
  assert.equal((await request('/approvals', 'POST', { id: pendingApproval.body[0].id, allow: true })).status, 200);
  await finish(session.id);
  const denied = (await request('/sessions/' + session.id)).body.messages.filter((m: { role: string }) => m.role === 'toolResult').at(-1);
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Tool denied by conversation/);
  assert.equal((await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'standard' })).status, 200);
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Cancel pending approval' });
  await waitUntil(() => request('/approvals'), (r) => r.body.length > 0);
  await request('/sessions/' + session.id + '/cancel', 'POST', {}); await finish(session.id);
  assert.deepEqual((await request('/approvals')).body, []);
});

test('full access bypasses Shell prompts only for its conversation and applies to pending approvals', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Command finished' : { tool: 'sandbox_shell', args: { command: 'echo permitted' } });
  await app.runtime.updateSettings({ plugins: { shell: true }, pluginConfig: { shell: { mode: 'host' } } });

  const { body: full } = await request('/sessions', 'POST', { permission: 'fullAccess' });
  const { body: standard } = await request('/sessions', 'POST', {});
  assert.equal(full.permission, 'fullAccess');
  assert.equal(standard.permission, 'standard');
  await request('/sessions/' + full.id + '/runs', 'POST', { message: 'Run without approval' });
  assert.equal((await finish(full.id)).body.run.state, 'completed');
  const fullHistory = (await request('/sessions/' + full.id)).body.messages;
  assert.equal(fullHistory.filter((message: { role: string }) => message.role === 'toolResult').at(-1)?.isError, false);
  assert.deepEqual((await request('/approvals')).body, []);
  assert.equal((await request('/sessions/' + standard.id)).body.permission, 'standard');

  await request('/sessions/' + standard.id + '/runs', 'POST', { message: 'Switch while pending' });
  await waitUntil(() => request('/approvals'), ({ body }) => body.some((item: { sessionId: string }) => item.sessionId === standard.id));
  assert.equal((await request('/sessions/' + standard.id + '/permissions', 'PATCH',
    { permission: 'fullAccess' })).status, 200);
  assert.deepEqual((await request('/approvals')).body, []);
  assert.equal((await finish(standard.id)).body.run.state, 'completed');
  const switched = (await request('/sessions/' + standard.id)).body.messages;
  assert.equal(switched.filter((message: { role: string }) => message.role === 'toolResult').at(-1)?.isError, false);

  assert.equal((await request('/sessions/' + standard.id + '/permissions', 'PATCH',
    { permission: 'standard' })).status, 200);
  await request('/sessions/' + standard.id + '/runs', 'POST', { message: 'Approval restored' });
  const pending = await waitUntil(() => request('/approvals'), ({ body }) => body.length === 1);
  assert.equal(pending.body[0].sessionId, standard.id);
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: true });
  await finish(standard.id);

  const parent = app.runtime.registry.create({ permission: 'readOnly' });
  const child = app.runtime.registry.create({ parentId: parent.id, permission: 'fullAccess' });
  assert.equal(app.runtime.plugins.ctx.harnessTools.forSession(child.id).some(({ name }) => name === 'sandbox_shell'), false);
});

test('disabling Shell waits until conversations using its tools have finished', { timeout: 15000 }, async (t) => {
  let entered: () => void;
  let release: () => void = () => { throw new Error('Not started'); };
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { app, request, finish } = await fixture(t, async ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
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
    assert.equal((await request('/settings', 'PATCH', { plugins: { shell: false } })).status, 409);
    const approval = (await request('/approvals')).body[0];
    assert.equal((await request('/approvals', 'POST', { id: approval.id, allow: false })).status, 200);
    assert.ok(app.runtime.runs.active(other.id));
    assert.equal((await finish(shell.id)).body.run.state, 'completed');
    const tool = expectPresent(app.runtime.agent.messages(shell.id).find(({ role }) => role === 'toolResult'), 'shell tool result');
    assert.equal(tool.isError, true);
  } finally { release(); }
  assert.equal(await pending, 'Unrelated task completed');
  assert.equal((await request('/settings', 'PATCH', { plugins: { shell: false } })).status, 200);
  assert.deepEqual((await request('/approvals')).body, []);
  const graph = (await request('/bootstrap')).body.ui;
  assert.ok(!graph.some(({ id }: { id: string }) => id === 'shell'));
  assert.ok(!app.runtime.plugins.ctx.harnessTools.forSession(shell.id).some(({ name }) => name === 'sandbox_shell'));
});

test('Shell defaults to host only when isolation is unavailable', () => {
  assert.equal(defaultShellMode, supportsIsolation() ? 'isolated' : 'host');
});

test('repeating a denied command in the same run does not open a new approval', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) =>
    messages.filter(({ role }) => role === 'tool').length === 2 ? 'Done' : { tool: 'sandbox_shell', args: { command: 'echo repeated' } });
  await app.runtime.updateSettings({ plugins: { shell: true }, pluginConfig: { shell: { mode: 'host' } } });
  const { body: session } = await request('/sessions', 'POST', {});
  const url = '/sessions/' + session.id;
  await request(url + '/runs', 'POST', { message: 'Try twice' });
  const pending = await waitUntil(() => request('/approvals'), (result) => result.body.length === 1);
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: false });
  assert.equal((await finish(session.id)).body.run.state, 'completed');
  assert.deepEqual((await request('/approvals')).body, []);
  const history = (await request(url)).body.messages;
  assert.deepEqual(history.filter((message: { role: string }) => message.role === 'toolResult')
    .map((message: { approvalDenied: boolean }) => message.approvalDenied), [true, true]);
});
