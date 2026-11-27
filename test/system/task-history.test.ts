import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../support/profile.ts';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';

test('durable retained tasks recover by ID without reconstructing execution handles', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  let ctx = app.runtime.plugins.ctx;
  const session = ctx.harnessSessions.create();
  const owner = 'session:' + session.id;
  const done = ctx.harnessTasks.start<string>(
    { ...ctx.harnessSessions.task(session.id), project: (value) => value },
    async (task) => {
      task.write('hello', 'stdout');
      return 'finished';
    },
  );
  assert.equal(await done.result, 'finished');
  assert.equal(ctx.harnessTasks.get(done.id), undefined);
  assert.equal(ctx.harnessSessions.taskHistory(done.id)?.result, 'finished');
  assert.deepEqual(
    ctx.harnessSessions.taskSummaries(session.id).map(({ id }) => id),
    [done.id],
  );
  ctx.harnessRuns.send(session.id, { message: 'A run' });
  const run = ctx.harnessRuns.current(session.id)!;
  await run.result;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unfinished = ctx.harnessTasks.start(ctx.harnessSessions.task(session.id), async ({ signal }) => {
    signal.throwIfAborted();
    entered();
    await new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await running;
  assert.deepEqual(
    ctx.harnessSessions
      .taskSummaries(session.id, undefined, 1, new Set([run.id, unfinished.id]))
      .map(({ id }) => id),
    [done.id],
  );
  // Simulate a committed task acceptance whose executor was lost without settlement.
  const lost = 'lost-task';
  ctx.harnessSessions.log(session.id).append({
    type: 'task',
    task: {
      id: lost,
      owner,
      state: 'running',
      createdAt: new Date().toISOString(),
      cancellationRequested: false,
      outputCursor: 0,
    },
  });
  const paused = ctx.harnessSessions.create();
  ctx.harnessRuns.stop(paused.id);
  for (const id of ['already-delivered', 'missed']) {
    ctx.harnessSessions.log(paused.id).append({
      type: 'task',
      task: {
        id,
        owner: 'session:' + paused.id,
        type: 'background-tool',
        state: 'completed',
        createdAt: new Date().toISOString(),
        cancellationRequested: false,
        outputCursor: 0,
        result: 'saved result',
      },
    });
  }
  ctx.harnessRuns.send(paused.id, {
    message: 'Original delivery',
    mode: 'queue',
    messageId: 'already-delivered:settled',
  });
  await app.close();
  await assert.rejects(unfinished.result);
  app = await createMiniHarnessServer(paths);
  ctx = app.runtime.plugins.ctx;
  const file = join(
    paths.home,
    'sessions',
    session.workspaceId?.slice(0, 16) ?? 'unbound',
    session.id + '.jsonl',
  );
  renameSync(file, file + '.held');
  try {
    assert.equal(ctx.harnessSessions.taskHistory(done.id)?.result, 'finished');
    assert.deepEqual(ctx.harnessSessions.taskOutput(done.id)?.chunks, [
      { start: 0, end: 5, channel: 'stdout', text: 'hello' },
    ]);
    assert.deepEqual(
      ctx.harnessSessions.taskSummaries(session.id, 'agent-run', 1).map(({ id }) => id),
      [run.id],
    );
    assert.equal(ctx.harnessSessions.taskHistory(run.id)?.state, 'completed');
    assert.equal(ctx.harnessSessions.taskHistory(unfinished.id)?.state, 'interrupted');
    assert.equal(ctx.harnessSessions.taskHistory(lost)?.state, 'interrupted');
  } finally {
    renameSync(file + '.held', file);
  }
  assert.deepEqual(
    ctx.harnessSessions
      .log(paused.id)
      .inbox()
      .map(({ id, text }) => [id, text]),
    [
      ['already-delivered:settled', 'Original delivery'],
      ['missed:settled', 'Background tool: completed "saved result"'],
    ],
  );
  assert.ok(
    ctx.harnessSessions
      .log(session.id)
      .entries()
      .some((entry) => entry.type === 'task' && entry.task.id === lost && entry.task.state === 'interrupted'),
  );
  assert.equal(ctx.harnessTasks.cancel(done.id), false);
  assert.equal(ctx.harnessTasks.list().length, 0);
  await ctx.harnessSessions.delete([session.id]);
  assert.equal(ctx.harnessSessions.taskHistory(done.id), undefined);
  assert.throws(() => ctx.harnessSessions.task(session.id), /Conversation not found/);
  // The scheduler itself never interprets an opaque owner key as a session ID.
  await ctx.harnessTasks.start({ owner }, async () => {}).result;
});
