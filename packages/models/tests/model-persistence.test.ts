import { expectPresent } from '../../../test/support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '@mini-harness/host/application';
import { readJson, writeJson } from '@mini-harness/platform/config';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

test('recent main model survives navigation, child overrides and a restart through the native agent', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const config = readJson<any>(join(paths.home, 'models.json'), {});
  config.providers['local-mock'].models.push({ ...config.providers['local-mock'].models[0], id: 'second-model' });
  writeJson(join(paths.home, 'models.json'), config);
  writeJson(paths.settings, { model: { provider: 'local-mock', id: 'mock-model' }, queueMode: 'followUp', appearance: 'dark',
    pluginConfig: { 'core:theme': { appearance: 'light' } } });
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const migrated = readJson<any>(paths.settings, {});
  assert.deepEqual(migrated.pluginConfig, {
    'core:models': { model: { provider: 'local-mock', id: 'mock-model' } },
    'core:conversation': { queueMode: 'followUp' },
    'core:theme': { appearance: 'light' },
  });
  for (const key of ['model', 'queueMode', 'appearance']) assert.equal(Object.hasOwn(migrated, key), false);
  const old = runtime.registry.create();
  const other = runtime.registry.create();
  await runtime.runs.send(old.id, 'First');
  const original = runtime.agent.read(old.id);
  await runtime.updateSettings({ pluginConfig: { 'core:models': { model: { provider: 'local-mock', id: 'second-model' } } } });
  await runtime.getConversation(old.id);
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  assert.deepEqual(runtime.agent.read(old.id).messages, original.messages);
  assert.deepEqual(runtime.agent.read(old.id).model, original.model);
  await runtime.runs.send(old.id, 'Switch the recent model');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  await expectPresent(runtime.delegation, 'delegation service').run(old.id, 'Child override', { provider: 'local-mock', id: 'mock-model' });
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  await runtime.runs.send(other.id, 'Other conversation');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
  await runtime.stop();
  runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  assert.equal(runtime.plugins.ctx.harnessModelPreference.recent().id, 'second-model');
  await runtime.runs.send(old.id, 'After restart');
  assert.equal(mock.requests.at(-1)?.model, 'second-model');
});
