import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { runTool } from '@mini-harness/tools/execution';
import { fixture, waitUntil } from '../support/api-fixture.ts';
import { expectPresent } from '../support/required.ts';
import { sendRun } from '../support/runs.ts';
import { createMiniHarnessServer } from '../support/profile.ts';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';

test('Background recovers unfinished work and delivers only missed durable reports', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { harnessSessions: sessions, harnessRuns: runs } = app.runtime.plugins.ctx;
  const { id } = sessions.create();
  runs.stop(id);
  const owner = { pluginId: 'background', instanceId: 'background' };
  for (const [workId, state] of [
    ['already-delivered', 'completed'],
    ['lost', 'queued'],
  ]) {
    sessions.log(id).append({
      type: 'plugin-record',
      owner,
      scope: 'session',
      key: workId,
      data: {
        work: {
          id: workId,
          tool: 'fixture',
          name: 'Fixture',
          arguments: {},
          state,
          createdAt: new Date().toISOString(),
          cancellationRequested: false,
          outputCursor: 0,
        },
      },
    });
  }
  runs.send(id, { message: 'Original delivery', messageId: 'already-delivered:settled' });

  for (let restart = 0; restart < 2; restart++) {
    await app.close();
    app = await createMiniHarnessServer(paths);
    const { harnessSessions, harnessTasks } = app.runtime.plugins.ctx;
    assert.deepEqual(harnessTasks.list(), []);
    assert.deepEqual(
      harnessSessions
        .log(id)
        .inbox()
        .map(({ id }) => id),
      ['already-delivered:settled', 'lost:settled'],
    );
    const records = harnessSessions.pluginRecords<{ work: { id: string; state: string } }>(id, owner);
    assert.deepEqual(
      records.map(({ data: { work } }) => [work.id, work.state]),
      [
        ['already-delivered', 'completed'],
        ['lost', 'interrupted'],
      ],
    );
  }
});

test('Background can wait and cancel independently with Subagents disabled', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, request } = await fixture(t, async ({ messages }) => {
    if (messages.at(-1)?.role !== 'tool')
      return { tool: 'start_background', args: { tool: 'fixture_work', arguments: {} } };
    await held;
    return 'Started';
  });
  const ctx = app.runtime.plugins.ctx;
  await app.runtime.configuration.update({ entries: { subagents: { disabled: true } } });
  ctx.harnessTools.register({
    name: 'fixture_work',
    description: 'Produce output until cancelled',
    parameters: { type: 'object' },
    background: true,
    async execute(_, { signal, write }) {
      write('Still running', 'stdout');
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const { id } = ctx.harnessSessions.create();
  const runs = ctx.harnessRuns;
  const stopped = assert.rejects(sendRun(runs, id, 'Start work'), /Stopped by the user/);
  const route = '/sessions/' + id + '/background';
  let workId: string;
  try {
    const [work] = await waitUntil(
      async () => (await request(route)).body,
      (items) => items[0]?.outputCursor > 0,
    );
    workId = work.id;
    assert.equal(runs.stop(id), true);
    await stopped;
  } finally {
    release();
  }
  const { body: output } = await request(route + '/' + workId + '/output?after=6');
  assert.equal(output.chunks[0]?.text, 'running');

  const control = expectPresent(
    ctx.harnessTools.list({ resourceId: id }).find(({ name }) => name === 'background_control'),
    'background control',
  );
  const waiting = runTool(control, 'wait', { action: 'wait', workId });
  assert.deepEqual((await request(route + '/' + workId, 'DELETE')).body, { cancelled: true });
  const result = await waiting;
  assert.equal(
    JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '').state,
    'cancelled',
  );
  assert.equal(ctx.harnessSessions.hasInbox(id, workId + ':settled'), true);
});
