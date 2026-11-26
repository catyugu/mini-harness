import { sendRun } from '../../../test/support/runs.ts';
import { runTool } from '@mini-harness/tools/execution';
import { isViewMessage } from '@mini-harness/sessions/message';
import { conversationTools } from '@mini-harness/runs/tool-selection';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture, waitUntil } from '../../../test/support/api-fixture.ts';

test('shell approval gates execution, handles rejection and cancellation', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool'
      ? 'Tool completed'
      : { tool: 'sandbox_shell', args: { command: 'echo approved' } },
  );
  await app.runtime.configuration.update({
    entries: { shell: { disabled: false, config: { mode: 'host' } } },
  });
  const { body: session } = await request('/sessions', 'POST', {});
  for (const allow of [false, true]) {
    await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Run a shell command' });
    const pending = await waitUntil(
      () => request('/approvals'),
      (r) => r.body.length > 0,
    );
    assert.equal(pending.body[0].message, 'echo approved');
    assert.equal((await request('/approvals', 'POST', { id: pending.body[0].id, allow })).status, 200);
    await finish(session.id);
    const history = (await request('/sessions/' + session.id)).body.timeline;
    const tool = history.filter((m: { role: string }) => m.role === 'toolResult').at(-1);
    assert.equal(tool.isError, !allow);
    assert.deepEqual(tool.arguments, { command: 'echo approved' });
    assert.ok(Number.isFinite(tool.approvalMs) && tool.approvalMs >= 0);
    if (!allow) {
      assert.equal(tool.toolState, 'denied');
      assert.equal(tool.elapsedMs, 0);
    }
    if (allow) {
      assert.match(JSON.stringify(tool.content), /approved/);
      assert.equal(tool.exitCode, 0);
      assert.ok(Number.isFinite(tool.elapsedMs) && tool.elapsedMs >= 0);
      const restored = (await request('/sessions/' + session.id)).body.timeline
        .filter((m: { role: string }) => m.role === 'toolResult')
        .at(-1);
      assert.equal(restored.exitCode, 0);
      assert.ok(Number.isFinite(restored.elapsedMs) && restored.elapsedMs >= 0);
    }
  }
  const other = (await request('/sessions', 'POST', {})).body;
  assert.equal(other.permission, 'standard');
  assert.equal(
    (await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'readOnly' })).status,
    200,
  );
  assert.equal((await request('/sessions/' + session.id)).body.permission, 'readOnly');
  assert.equal((await request('/sessions/' + other.id)).body.permission, 'standard');
  const ctx = app.runtime.plugins.ctx;
  assert.ok(
    conversationTools(ctx, session.id, ctx.harnessSessions.runScope(session.id)).some(
      ({ name }) => name === 'read',
    ),
  );
  assert.ok(
    !conversationTools(ctx, session.id, ctx.harnessSessions.runScope(session.id)).some(
      ({ name }) => name === 'sandbox_shell' || name === 'write',
    ),
  );
  assert.ok(
    conversationTools(ctx, other.id, ctx.harnessSessions.runScope(other.id)).some(
      ({ name }) => name === 'sandbox_shell',
    ),
  );
  assert.equal(
    (await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'invalid' })).status,
    400,
  );
  assert.equal(
    (await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'standard' })).status,
    200,
  );
  await request('/sessions/' + session.id + '/runs', 'POST', {
    message: 'Permission changed while awaiting approval',
  });
  const pendingApproval = await waitUntil(
    () => request('/approvals'),
    (r) => r.body.length > 0,
  );
  assert.equal(
    (await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'readOnly' })).status,
    200,
  );
  assert.equal(
    (await request('/approvals', 'POST', { id: pendingApproval.body[0].id, allow: true })).status,
    200,
  );
  await finish(session.id);
  const denied = (await request('/sessions/' + session.id)).body.timeline
    .filter((m: { role: string }) => m.role === 'toolResult')
    .at(-1);
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Tool denied by conversation/);
  assert.equal(
    (await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'standard' })).status,
    200,
  );
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Cancel pending approval' });
  await waitUntil(
    () => request('/approvals'),
    (r) => r.body.length > 0,
  );
  await request('/sessions/' + session.id + '/cancel', 'POST', {});
  await finish(session.id);
  assert.deepEqual((await request('/approvals')).body, []);
  const cancelled = (await request('/sessions/' + session.id)).body.timeline
    .filter((message: { role: string }) => message.role === 'toolResult')
    .at(-1);
  assert.equal(cancelled.toolState, 'cancelled');
  assert.equal(cancelled.isError, true);
});

test('full access bypasses Shell prompts only for its conversation and applies to pending approvals', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool'
      ? 'Command finished'
      : { tool: 'sandbox_shell', args: { command: 'echo permitted' } },
  );
  await app.runtime.configuration.update({
    entries: { shell: { disabled: false, config: { mode: 'host' } } },
  });

  const { body: full } = await request('/sessions', 'POST', { permission: 'fullAccess' });
  const { body: standard } = await request('/sessions', 'POST', {});
  assert.equal(full.permission, 'fullAccess');
  assert.equal(standard.permission, 'standard');
  await request('/sessions/' + full.id + '/runs', 'POST', { message: 'Run without approval' });
  assert.equal((await finish(full.id)).body.run.state, 'completed');
  const fullHistory = (await request('/sessions/' + full.id)).body.timeline;
  assert.equal(
    fullHistory.filter((message: { role: string }) => message.role === 'toolResult').at(-1)?.isError,
    false,
  );
  assert.deepEqual((await request('/approvals')).body, []);
  assert.equal((await request('/sessions/' + standard.id)).body.permission, 'standard');

  await request('/sessions/' + standard.id + '/runs', 'POST', { message: 'Switch while pending' });
  await waitUntil(
    () => request('/approvals'),
    ({ body }) => body.some((item: { sessionId: string }) => item.sessionId === standard.id),
  );
  assert.equal(
    (await request('/sessions/' + standard.id + '/permissions', 'PATCH', { permission: 'fullAccess' }))
      .status,
    200,
  );
  assert.deepEqual((await request('/approvals')).body, []);
  assert.equal((await finish(standard.id)).body.run.state, 'completed');
  const switched = (await request('/sessions/' + standard.id)).body.timeline;
  assert.equal(
    switched.filter((message: { role: string }) => message.role === 'toolResult').at(-1)?.isError,
    false,
  );

  assert.equal(
    (await request('/sessions/' + standard.id + '/permissions', 'PATCH', { permission: 'standard' })).status,
    200,
  );
  await request('/sessions/' + standard.id + '/runs', 'POST', { message: 'Approval restored' });
  const pending = await waitUntil(
    () => request('/approvals'),
    ({ body }) => body.length === 1,
  );
  assert.equal(pending.body[0].sessionId, standard.id);
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: true });
  await finish(standard.id);

  const parent = app.runtime.plugins.ctx.harnessSessions.create({ permission: 'readOnly' });
  const child = app.runtime.plugins.ctx.harnessSessions.create({
    parentId: parent.id,
    permission: 'fullAccess',
  });
  assert.equal(
    conversationTools(
      app.runtime.plugins.ctx,
      child.id,
      app.runtime.plugins.ctx.harnessSessions.runScope(child.id),
    ).some(({ name }) => name === 'sandbox_shell'),
    false,
  );
});

test(
  'disabling Shell cancels its pending approval while an unrelated run continues',
  { timeout: 15000 },
  async (t) => {
    let entered: () => void;
    let release: () => void = () => {
      throw new Error('Not started');
    };
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    await app.runtime.configuration.update({
      entries: { shell: { disabled: false, config: { mode: 'host' } } },
    });
    const shell = app.runtime.plugins.ctx.harnessSessions.create();
    const other = app.runtime.plugins.ctx.harnessSessions.create();
    const pending = sendRun(app.runtime.plugins.ctx.harnessRuns, other.id, 'Unrelated task');
    try {
      await running;
      await request('/sessions/' + shell.id + '/runs', 'POST', { message: 'Run Shell' });
      await waitUntil(
        () => request('/approvals'),
        (result) => result.body.length === 1,
      );
      assert.equal(
        (await request('/settings', 'PATCH', { entries: { shell: { disabled: true } } })).status,
        200,
      );
      assert.deepEqual((await request('/approvals')).body, []);
      assert.ok(app.runtime.plugins.ctx.harnessRuns.current(other.id));
      assert.equal((await finish(shell.id)).body.run.state, 'completed');
      const tool = expectPresent(
        app.runtime.plugins.ctx.harnessSessions
          .log(shell.id)
          .projection()
          .timeline.filter(isViewMessage)
          .find(({ role }) => role === 'toolResult'),
        'shell tool result',
      );
      assert.equal(tool.isError, true);
    } finally {
      release();
    }
    assert.equal(await pending, 'Unrelated task completed');
    const graph = (await request('/bootstrap')).body.ui;
    assert.ok(!graph.some(({ id }: { id: string }) => id === 'shell'));
    assert.ok(
      !conversationTools(
        app.runtime.plugins.ctx,
        shell.id,
        app.runtime.plugins.ctx.harnessSessions.runScope(shell.id),
      ).some(({ name }) => name === 'sandbox_shell'),
    );
  },
);

test('repeating a denied command in the same run does not open a new approval', async (t) => {
  const { app, request, finish } = await fixture(t, ({ messages }) =>
    messages.filter(({ role }) => role === 'tool').length === 2
      ? 'Done'
      : { tool: 'sandbox_shell', args: { command: 'echo repeated' } },
  );
  await app.runtime.configuration.update({
    entries: { shell: { disabled: false, config: { mode: 'host' } } },
  });
  const { body: session } = await request('/sessions', 'POST', {});
  const url = '/sessions/' + session.id;
  await request(url + '/runs', 'POST', { message: 'Try twice' });
  const pending = await waitUntil(
    () => request('/approvals'),
    (result) => result.body.length === 1,
  );
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: false });
  assert.equal((await finish(session.id)).body.run.state, 'completed');
  assert.deepEqual((await request('/approvals')).body, []);
  const history = (await request(url)).body.timeline;
  assert.deepEqual(
    history
      .filter((message: { role: string }) => message.role === 'toolResult')
      .map((message: { toolState: string }) => message.toolState === 'denied'),
    [true, true],
  );
});

test('independent shell calls use one task, retain output channels and do not duplicate process output', async (t) => {
  const { app } = await fixture(t);
  const ctx = app.runtime.plugins.ctx;
  await app.runtime.configuration.update({
    entries: { shell: { disabled: false, config: { mode: 'host' } } },
  });
  const session = ctx.harnessSessions.create({ permission: 'fullAccess' });
  ctx.harnessRuns.stop(session.id);
  const tool = ctx.harnessTools
    .list({ resourceId: session.id, scope: ctx.harnessSessions.runScope(session.id) })
    .find(({ name }) => name === 'start_background');
  assert.ok(tool);
  const receipt = await runTool(tool, 'background-shell', {
    tool: 'sandbox_shell',
    arguments: { command: 'echo task-output' },
  });
  const id = String(receipt.details?.taskId);
  const task = await ctx.harnessTasks.wait(id);
  assert.equal(task.state, 'completed');
  assert.deepEqual(task.metadata, { tool: 'sandbox_shell', arguments: { command: 'echo task-output' } });
  assert.equal((task.result as { details: { exitCode: number } }).details.exitCode, 0);
  assert.equal(ctx.harnessTasks.list('session:' + session.id).length, 1);
  assert.match(
    ctx.harnessTasks
      .readOutput(id)
      ?.chunks.filter(({ channel }) => channel === 'stdout')
      .map(({ text }) => text)
      .join('') ?? '',
    /task-output/,
  );
  assert.doesNotMatch(JSON.stringify(task.result), /task-output/);
  await ctx.harnessSessions.delete([session.id]);
  assert.equal(ctx.harnessTasks.get(id), undefined);
});

test(
  'stopping a conversation leaves the independent shell approval pending',
  { timeout: 15000 },
  async (t) => {
    let release!: () => void;
    let started!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.after(() => release());
    const { app, request } = await fixture(t, async ({ messages }) => {
      if (messages.at(-1)?.content === 'Hold foreground') {
        started();
        await hold;
      }
      return 'Done';
    });
    const ctx = app.runtime.plugins.ctx;
    await app.runtime.configuration.update({
      entries: { shell: { disabled: false, config: { mode: 'host' } } },
    });
    const { id } = ctx.harnessSessions.create();
    const foreground = sendRun(ctx.harnessRuns, id, 'Hold foreground');
    const cancelled = assert.rejects(foreground, /Stopped by the user/);
    await entered;
    const background = expectPresent(
      conversationTools(ctx, id).find(({ name }) => name === 'start_background'),
      'background entry',
    );
    const receipt = await runTool(background, 'independent-approval', {
      tool: 'sandbox_shell',
      arguments: { command: 'echo independently-approved' },
    });
    const taskId = String(receipt.details?.taskId);
    const approvals = ctx.harnessApprovals;
    const requestId = (
      await waitUntil(
        () => approvals.list(),
        (list) => list.length === 1,
      )
    )[0].id;
    assert.equal(ctx.harnessRuns.stop(id), true);
    await cancelled;
    assert.equal(approvals.list().at(0)?.id, requestId);
    assert.equal((await request('/approvals', 'POST', { id: requestId, allow: true })).status, 200);
    assert.equal((await ctx.harnessTasks.wait(taskId)).state, 'completed');
    await waitUntil(
      () => ctx.harnessSessions.log(id).inbox(),
      (items) => items.some(({ origin }) => origin?.taskId === taskId),
    );
    assert.equal(ctx.harnessRuns.current(id), undefined);
    release();
  },
);
