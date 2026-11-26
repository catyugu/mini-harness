import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createMiniHarnessServer } from '../../../test/support/profile.ts';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.ts';

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
  await app.close();
  await assert.rejects(unfinished.result);
  app = await createMiniHarnessServer(paths);
  ctx = app.runtime.plugins.ctx;
  assert.equal(ctx.harnessTasks.get(done.id)?.result, 'finished');
  assert.deepEqual(ctx.harnessTasks.readOutput(done.id)?.chunks, [
    { start: 0, end: 5, channel: 'stdout', text: 'hello' },
  ]);
  assert.equal(ctx.harnessTasks.get(run.id)?.state, 'completed');
  assert.equal(ctx.harnessTasks.get(unfinished.id)?.state, 'interrupted');
  assert.equal(ctx.harnessTasks.get(lost)?.state, 'interrupted');
  assert.ok(
    ctx.harnessSessions
      .log(session.id)
      .entries()
      .some((entry) => entry.type === 'task' && entry.task.id === lost && entry.task.state === 'interrupted'),
  );
  assert.equal(ctx.harnessTasks.cancel(done.id), false);
  assert.equal(ctx.harnessTasks.list().length, 0);
  await ctx.harnessSessions.delete([session.id]);
  assert.equal(ctx.harnessTasks.get(done.id), undefined);
  assert.throws(() => ctx.harnessSessions.task(session.id), /Conversation not found/);
  // The scheduler itself never interprets an opaque owner key as a session ID.
  await ctx.harnessTasks.start({ owner }, async () => {}).result;
});
