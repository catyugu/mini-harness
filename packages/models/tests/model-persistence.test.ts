import { expectPresent } from '../../../test/support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '../../../test/support/profile.js';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

test('recent main model survives child overrides and a restart through the native agent', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const config = readJson<any>(join(paths.home, 'models.json'), {});
  config.providers['local-mock'].models.push({ ...config.providers['local-mock'].models[0], id: 'second-model' });
  writeJson(join(paths.home, 'models.json'), config);
  writeJson(paths.settings, { pluginConfig: { 'core:models': { model: { provider: 'local-mock', id: 'mock-model' } } } });
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const old = runtime.plugins.ctx.harnessRegistry.create();
  const other = runtime.plugins.ctx.harnessRegistry.create();
  await runtime.plugins.ctx.harnessRuns.send(old.id, 'First');
  const original = runtime.plugins.ctx.harnessRegistry.log(old.id).projection();
  await runtime.configuration.update({ pluginConfig: { 'core:models': { model: { provider: 'local-mock', id: 'second-model' } } } });
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  assert.deepEqual(runtime.plugins.ctx.harnessRegistry.log(old.id).projection().messages, original.messages);
  assert.deepEqual(runtime.plugins.ctx.harnessRegistry.log(old.id).projection().model, original.model);
  await runtime.plugins.ctx.harnessRuns.send(old.id, 'Switch the recent model');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  const delegate = expectPresent(runtime.plugins.ctx.harnessTools.forSession(old.id).find(({ name }) => name === 'delegate'), 'delegate tool');
  await delegate.execute('override', { task: 'Child override', provider: 'local-mock', model: 'mock-model' });
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  runtime.plugins.ctx.harnessRegistry.log(other.id).append({
    type: 'inbox-enqueued',
    item: { id: 'recovered', mode: 'followUp', text: 'Recovered user follow-up', images: [],
      model: { provider: 'local-mock', id: 'mock-model' } }
  });
  await runtime.plugins.ctx.harnessRuns.send(other.id, 'Scheduled work', undefined, { source: 'plugin' });
  assert.equal(mock.requests.at(-1)?.model, 'mock-model');
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  await runtime.plugins.ctx.harnessRuns.send(other.id, 'Other conversation');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  await runtime.stop();
  runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  await runtime.plugins.ctx.harnessRuns.send(old.id, 'After restart');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
});

test('a failed recent-model write does not delay accepted input or terminate execution', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const file = join(paths.home, 'models.json');
  const catalog = readJson<{ providers: Record<string, { models: { id: string }[] }> }>(file, { providers: {} });
  const models = catalog.providers['local-mock'].models;
  models.push({ ...models[0], id: 'second-model' });
  writeJson(file, catalog);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const context = runtime.plugins.ctx;
  const { harnessRegistry: registry, harnessRuns: runs } = context;
  const session = registry.create();
  const config = join(paths.home, 'profiles', 'web', 'cordis.yml');
  const old = config + '.original';
  renameSync(config, old);
  mkdirSync(config);
  try {
    const run = runs.startRun(session.id, 'Accept this despite the unwritable setting', { model: { provider: 'local-mock', id: 'second-model' } });
    assert.equal(run.state, 'queued');
    await runs.completion(session.id);
    assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
    await runs.send(registry.create().id, 'Use the current preference despite the failed write');
    assert.equal(runs.info(session.id)?.state, 'completed');
    assert.equal(mock.requests.at(-1)?.model, 'second-model');
    await runtime.stop();
    assert.ok(context.logger.buffer.some(({ args }) => args[0] === 'Could not save recent model: %s'));
  } finally {
    rmSync(config, { recursive: true, force: true });
    renameSync(old, config);
  }
});
