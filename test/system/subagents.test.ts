import { sendRun, activeRunCount } from '../support/runs.ts';
import { runTool } from '@mini-harness/tools/execution';
import { isViewMessage } from '@mini-harness/sessions/message';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../support/profile.ts';
import { fixture, waitUntil } from '../support/api-fixture.ts';
import { expectPresent } from '../support/required.ts';
import { createMockProvider, createFixturePaths } from '../support/mock-provider.ts';

test(
  'Native execution reads explicit paths and recursive task waits release the single child slot',
  { timeout: 30000 },
  async (t) => {
    const mock = await createMockProvider(({ messages }) => {
      const last = messages.at(-1);
      assert.ok(last);
      if (last.role === 'tool') {
        if (last.content.startsWith('{')) {
          const payload = JSON.parse(last.content);
          if (payload.taskId && payload.state === 'accepted')
            return { tool: 'task_control', args: { action: 'wait', taskId: payload.taskId } };
          if (payload.taskId) assert.equal(payload.state, 'completed');
        }
        return (
          'Finished ' + ([...messages].reverse().find((message) => message.role === 'user')?.content ?? '')
        );
      }
      if (last.content === 'root task')
        return { tool: 'delegate', args: { task: 'child task', provider: 'local-mock' } };
      if (last.content.replace(/^\[agent[^\]]+\] /, '') === 'child task')
        return { tool: 'delegate', args: { task: 'leaf task' } };
      if (last.content === 'read policy') return { tool: 'read', args: { path: '../outside.txt' } };
      return 'Leaf finished';
    });
    const { root, paths } = createFixturePaths(mock.url);
    let app = await createMiniHarnessServer(paths);
    t.after(async () => {
      await app.close();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(join(root, 'outside.txt'), 'private fixture');
    await app.runtime.configuration.update({
      entries: {
        subagents: {
          config: { maxDepth: 2, maxParallel: 1, model: { provider: 'local-mock', id: 'mock-model' } },
        },
      },
    });
    const parent = app.runtime.plugins.ctx.harnessSessions.create();
    const toolEvents: Extract<import('@mini-harness/runs/stream').StreamEvent, { type: 'tool-end' }>[] = [];
    await sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'root task', (event) => {
      if (event.type === 'tool-end') toolEvents.push(event);
    });
    await waitUntil(
      () => app.runtime.plugins.ctx.harnessSessions.descendants([parent.id]).length,
      (length) => length === 3,
    );
    const records = app.runtime.plugins.ctx.harnessSessions
      .descendants([parent.id])
      .map((id) => app.runtime.plugins.ctx.harnessSessions.get(id));
    assert.deepEqual(
      records.map((record) => {
        assert.ok(record);
        return record.title;
      }),
      ['root task', 'child task', 'leaf task'],
    );
    const childRecord = records[1],
      leafRecord = records[2];
    assert.ok(childRecord && leafRecord);
    await app.runtime.plugins.ctx.harnessRuns.current(childRecord.id)?.result;
    await app.runtime.plugins.ctx.harnessRuns.current(leafRecord.id)?.result;
    const leafRun = expectPresent(app.runtime.plugins.ctx.harnessRuns.info(leafRecord.id), 'leaf run');
    assert.equal(
      app.runtime.plugins.ctx.harnessSessions.taskStatus(leafRecord.id, leafRun.id)?.outputCursor,
      0,
    );
    assert.deepEqual(app.runtime.plugins.ctx.harnessSessions.log(leafRecord.id).projection().model, {
      provider: 'local-mock',
      id: 'mock-model',
    });
    assert.equal(
      app.runtime.plugins.ctx.harnessTools
        .list({
          resourceId: leafRecord.id,
          scope: app.runtime.plugins.ctx.harnessSessions.runScope(leafRecord.id),
        })
        .map(({ name }) => name)
        .includes('delegate'),
      false,
    );
    assert.ok(
      toolEvents.some(
        (event) =>
          event.message.toolState === 'finished' && event.message.details?.sessionId === childRecord.id,
      ),
    );
    const check = app.runtime.plugins.ctx.harnessSessions.create();
    await sendRun(app.runtime.plugins.ctx.harnessRuns, check.id, 'read policy');
    const result = app.runtime.plugins.ctx.harnessSessions
      .log(check.id)
      .projection()
      .timeline.filter(isViewMessage)
      .find((message) => message.role === 'toolResult');
    assert.ok(result);
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.content), /private fixture/);
    await waitUntil(
      () => activeRunCount(app.runtime.plugins.ctx),
      (count) => count === 0,
    );
    await app.close();
    app = await createMiniHarnessServer(paths);
    await waitUntil(
      () => activeRunCount(app.runtime.plugins.ctx),
      (count) => count === 0,
    );
    const exported = app.runtime.plugins.ctx.harnessSessions.export([parent.id, childRecord.id]);
    assert.deepEqual(
      exported.map(({ id, parentId }) => ({ id, parentId })),
      records.map((record) => {
        assert.ok(record);
        return { id: record.id, parentId: record.parentId };
      }),
    );
    assert.ok(exported.every(({ log }) => log?.includes('"type":"session"')));
    assert.equal(
      app.runtime.plugins.ctx.harnessSessions.log(leafRecord.id).projection().model?.id,
      'mock-model',
    );
  },
);

test('stopping a root leaves its delegated child running', { timeout: 15000 }, async (t) => {
  const parentEntered = gate();
  const childEntered = gate();
  const held = gate();
  t.after(() => held.release());
  const { app } = await fixture(t, async ({ messages }) => {
    const last = messages.at(-1);
    if (last?.content === 'start child') return { tool: 'delegate', args: { task: 'hold child' } };
    if (last?.content.endsWith('] hold child')) childEntered.release();
    else parentEntered.release();
    await held.promise;
    return 'Released';
  });
  const ctx = app.runtime.plugins.ctx;
  const parent = ctx.harnessSessions.create();
  const pending = sendRun(ctx.harnessRuns, parent.id, 'start child');
  const aborted = assert.rejects(pending, /Stopped by the user/);
  await Promise.all([parentEntered.promise, childEntered.promise]);
  const child = ctx.harnessSessions.list().find(({ parentId }) => parentId === parent.id);
  assert.ok(child);
  const childRun = expectPresent(ctx.harnessRuns.info(child.id), 'child run');
  assert.equal(ctx.harnessRuns.stop(parent.id), true);
  await aborted;
  assert.equal(ctx.harnessTasks.get(childRun.id)?.state, 'running');
  held.release();
  await ctx.harnessRuns.current(child.id)?.result;
  assert.equal(ctx.harnessSessions.taskStatus(child.id, childRun.id)?.state, 'completed');
  assert.equal(activeRunCount(ctx), 0);
  assert.equal(ctx.harnessSessions.export([parent.id]).length, 2);
});

function gate() {
  let release: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release: () => release() };
}

test(
  'child queues honor live limits, explicit cancellation, and depth restrictions',
  { timeout: 15000 },
  async (t) => {
    const held = [gate(), gate(), gate()];
    const entered = [gate(), gate(), gate()];
    let requests = 0;
    t.after(() => {
      for (const gate of held) gate.release();
    });
    const { app } = await fixture(t, async () => {
      const index = requests++;
      const ready = entered[index],
        gate = held[index];
      assert.ok(ready && gate, 'Mock received more requests than expected');
      ready.release();
      await gate.promise;
      return 'Done';
    });
    await app.runtime.configuration.update({ entries: { subagents: { config: { maxParallel: 1 } } } });
    const parent = app.runtime.plugins.ctx.harnessSessions.create();
    app.runtime.plugins.ctx.harnessRuns.stop(parent.id);
    const tools = app.runtime.plugins.ctx.harnessTools;
    const delegate = expectPresent(
      tools
        .list({ resourceId: parent.id, scope: app.runtime.plugins.ctx.harnessSessions.runScope(parent.id) })
        .find(({ name }) => name === 'delegate'),
      'delegate tool',
    );
    const start = (task: string) =>
      runTool(delegate, task, {
        task,
        provider: 'local-mock',
        model: 'mock-model',
      });
    const first = await start('First child');
    assert.ok(entered[0] && entered[1]);
    await entered[0].promise;
    const second = await start('Second child');
    const third = await start('Cancelled queued child');
    assert.equal(third.details?.state, 'accepted');
    const queued = await waitUntil(
      () =>
        app.runtime.plugins.ctx.harnessSessions
          .list()
          .find(({ title }) => title === 'Cancelled queued child'),
      Boolean,
    );
    assert.ok(queued);
    assert.equal(app.runtime.plugins.ctx.harnessRuns.info(queued.id)?.state, 'queued');
    app.runtime.plugins.ctx.harnessRuns.stop(queued.id);
    await app.runtime.plugins.ctx.harnessRuns.current(queued.id)?.result?.catch(() => {});
    assert.equal(app.runtime.plugins.ctx.harnessRuns.info(queued.id)?.state, 'cancelled');
    assert.equal(requests, 1);
    await app.runtime.configuration.update({ entries: { subagents: { config: { maxParallel: 2 } } } });
    await entered[1].promise;
    await app.runtime.configuration.update({ entries: { subagents: { config: { maxParallel: 1 } } } });
    assert.equal(
      activeRunCount(app.runtime.plugins.ctx),
      2,
      'Lowering the limit preserves existing executions',
    );
    const child = app.runtime.plugins.ctx.harnessSessions.list().find(({ title }) => title === 'First child');
    assert.ok(child);
    assert.equal(
      tools
        .list({ resourceId: child.id, scope: app.runtime.plugins.ctx.harnessSessions.runScope(child.id) })
        .some(({ name }) => name === 'delegate'),
      false,
    );
    assert.ok(held[0] && held[1]);
    held[0].release();
    held[1].release();
    await Promise.all(
      [first, second].map(
        (result) => app.runtime.plugins.ctx.harnessRuns.current(String(result.details?.sessionId))?.result,
      ),
    );
    assert.equal(activeRunCount(app.runtime.plugins.ctx), 0);
    assert.equal(requests, 2, 'Cancelled queued children never reach the provider');
  },
);

test(
  'agent messages steer an active child and wake an idle parent without ending the sender',
  { timeout: 15000 },
  async (t) => {
    const entered = gate();
    const held = gate();
    t.after(held.release);
    const { app } = await fixture(t, async ({ messages }) => {
      if (messages.at(-1)?.content.endsWith('] Original child input')) {
        entered.release();
        await held.promise;
      }
      return 'Acknowledged';
    });
    const { harnessRuns: runs, harnessSessions: sessions, harnessTools: tools } = app.runtime.plugins.ctx;
    const parent = sessions.create();
    const tool = (id: string, name: string) =>
      expectPresent(
        tools.list({ resourceId: id, scope: sessions.runScope(id) }).find((tool) => tool.name === name),
        name,
      );
    const child = await runTool(tool(parent.id, 'delegate'), 'delegate', {
      task: 'Original child input',
      provider: 'local-mock',
      model: 'mock-model',
    });
    const childId = String(child.details?.sessionId);
    const childRun = expectPresent(runs.current(childId), 'child task');
    await entered.promise;
    await runTool(tool(parent.id, 'send_message'), 'steer-child', {
      sessionId: childId,
      message: 'Additional instruction',
    });
    await runTool(
      tool(childId, 'send_message'),
      'report-to-parent',
      {
        sessionId: parent.id,
        message: 'Work started',
      },
      { executionId: childRun.id },
    );
    assert.equal(runs.current(childId)?.id, childRun.id);
    assert.equal(childRun.signal.aborted, false);
    await expectPresent(runs.current(parent.id), 'awakened parent').result;
    assert.equal(runs.current(childId)?.id, childRun.id);
    held.release();
    await childRun.result;
    await runs.current(parent.id)?.result;
    const childInputs = sessions
      .log(childId)
      .projection()
      .timeline.filter(isViewMessage)
      .filter(({ role }) => role === 'user');
    assert.equal(childInputs.length, 2);
    assert.ok(
      childInputs.every(
        ({ runId, origin }) => runId === childRun.id && origin?.senderSessionId === parent.id,
      ),
    );
    const parentInputs = sessions
      .log(parent.id)
      .projection()
      .timeline.filter(isViewMessage)
      .filter(({ role }) => role === 'user');
    assert.equal(parentInputs.length, 2);
    assert.ok(
      parentInputs.every(
        ({ origin }) => origin?.senderSessionId === childId && origin.taskId === childRun.id,
      ),
    );
    assert.equal(parentInputs[0].content, 'Work started');
    assert.match(JSON.stringify(parentInputs[1].content), /Child run completed/);
  },
);
