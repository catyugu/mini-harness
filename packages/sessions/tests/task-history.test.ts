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
  const done = ctx.harnessTasks.start<string>({ owner, projectResult: (value) => value }, async (task) => {
    task.write('hello', 'stdout');
    return 'finished';
  });
  assert.equal(await done.result, 'finished');
  const run = ctx.harnessRuns.submit(session.id, { message: 'A run' });
  await run.result;
  const unfinished = ctx.harnessTasks.start({ owner }, async ({ signal }) => {
    signal.throwIfAborted();
    await new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await ctx.harnessTasks.wait(unfinished.id, ({ state }) => state === 'running');
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
  assert.equal(ctx.harnessTasks.cancel(done.id), false);
  assert.equal(ctx.harnessTasks.list().length, 0);
  await ctx.harnessSessions.delete([session.id]);
  assert.equal(ctx.harnessTasks.get(done.id), undefined);
  assert.throws(() => ctx.harnessTasks.start({ owner }, async () => {}), /Conversation not found/);
});
