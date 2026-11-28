import { sendRun } from '../support/runs.ts';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import { runTool } from '@mini-harness/tools/execution';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '../support/profile.ts';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';

test('recent main model survives child overrides and a restart through the native agent', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const config = readJson<any>(join(paths.home, 'models.json'), {});
  config.providers['local-mock'].models.push({
    ...config.providers['local-mock'].models[0],
    id: 'second-model',
  });
  writeJson(join(paths.home, 'models.json'), config);
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const old = runtime.plugins.ctx.harnessSessions.create();
  const other = runtime.plugins.ctx.harnessSessions.create();
  await sendRun(runtime.plugins.ctx.harnessRuns, old.id, 'First');
  const original = runtime.plugins.ctx.harnessSessions.log(old.id).projection();
  await runtime.configuration.update({
    entries: { 'core:models': { config: { model: { provider: 'local-mock', id: 'second-model' } } } },
  });
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent()?.id, 'second-model');
  assert.deepEqual(runtime.plugins.ctx.harnessSessions.log(old.id).projection().timeline, original.timeline);
  assert.deepEqual(runtime.plugins.ctx.harnessSessions.log(old.id).projection().model, original.model);
  await sendRun(runtime.plugins.ctx.harnessRuns, old.id, 'Switch the recent model');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  const delegate = expectPresent(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: old.id, scope: runtime.plugins.ctx.harnessSessions.runScope(old.id) })
      .find(({ name }) => name === 'delegate'),
    'delegate tool',
  );
  const child = await runTool(delegate, 'override', {
    task: 'Child override',
    provider: 'local-mock',
    model: 'mock-model',
  });
  await runtime.plugins.ctx.harnessRuns.current(String(child.details?.sessionId))?.result;
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent()?.id, 'second-model');
  runtime.plugins.ctx.harnessSessions.log(other.id).append({
    type: 'inbox-enqueued',
    item: {
      id: 'recovered',
      mode: 'queue',
      text: 'Recovered user follow-up',
      origin: { source: 'plugin' },
      images: [],
      model: { provider: 'local-mock', id: 'mock-model' },
    },
  });
  await sendRun(runtime.plugins.ctx.harnessRuns, other.id, 'Scheduled work', undefined, { source: 'plugin' });
  assert.ok(mock.requests.some(({ model }) => model === 'mock-model'));
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent()?.id, 'second-model');
  await sendRun(runtime.plugins.ctx.harnessRuns, other.id, 'Other conversation');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  await runtime.stop();
  runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent()?.id, 'second-model');
  await sendRun(runtime.plugins.ctx.harnessRuns, old.id, 'After restart');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  await runtime.configuration.update({ entries: { 'core:pi-adapter': { disabled: true } } });
  assert.deepEqual(runtime.plugins.ctx.harnessModelPreference.recent(), null);
});

test('a failed recent-model write does not delay accepted input or terminate execution', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const file = join(paths.home, 'models.json');
  const catalog = readJson<{ providers: Record<string, { models: { id: string }[] }> }>(file, {
    providers: {},
  });
  const models = catalog.providers['local-mock'].models;
  models.push({ ...models[0], id: 'second-model' });
  writeJson(file, catalog);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const context = runtime.plugins.ctx;
  const { harnessSessions: registry, harnessRuns: runs } = context;
  const session = registry.create();
  const config = join(paths.home, 'profiles', 'web', 'cordis.patch.yml');
  const old = config + '.original';
  renameSync(config, old);
  mkdirSync(config);
  try {
    const run = runs.send(session.id, {
      message: 'Accept this despite the unwritable setting',
      model: { provider: 'local-mock', id: 'second-model' },
      origin: { source: 'user' },
    });
    assert.equal(run.run?.state, 'queued');
    await runs.current(session.id)?.result;
    assert.equal(runtime.plugins.ctx.harnessModelPreference.recent()?.id, 'second-model');
    await sendRun(runs, registry.create().id, 'Use the current preference despite the failed write');
    assert.equal(runs.info(session.id)?.state, 'completed');
    assert.equal(mock.requests.at(-1)?.model, 'second-model');
    await context.harnessModelStore.saveProvider({
      id: 'local-mock',
      name: 'Local mock',
      api: 'openai-completions',
      baseUrl: mock.url,
      models: [models[0]],
    });
    assert.equal(context.harnessModels.resolve({ provider: 'local-mock', id: 'second-model' }), undefined);
    assert.deepEqual(context.harnessModelPreference.recent(), null);
    // The original persisted model is still valid; selecting it requires no write.
    await context.harnessModelPreference.remember({ provider: 'local-mock', id: 'mock-model' });
    assert.equal(context.harnessModelPreference.recent()?.id, 'mock-model');
    await runtime.stop();
    assert.ok(context.logger.buffer.some(({ args }) => args[0] === 'Could not save recent model: %s'));
  } finally {
    rmSync(config, { recursive: true, force: true });
    renameSync(old, config);
  }
});

test('explicit and stored models work without the recent-model plugin', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  await runtime.configuration.update({ entries: { 'core:models': { disabled: true } } });
  const ctx = runtime.plugins.ctx;
  const session = ctx.harnessSessions.create();
  const model = { provider: 'local-mock', id: 'mock-model' };
  assert.equal(await sendRun(ctx.harnessRuns, session.id, 'Explicit', undefined, { model }), 'Mock response');
  assert.equal(await sendRun(ctx.harnessRuns, session.id, 'Stored'), 'Mock response');
});
