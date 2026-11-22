import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '../src/application.js';
import { createMiniHarnessServer } from '../src/server.js';
import { readJson, writeJson } from '../src/config.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';

test('recent main model survives navigation, child overrides and a restart through the real Pi SDK', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const config = readJson<any>(join(paths.home, 'models.json'), {});
  config.providers['local-mock'].models.push({ ...config.providers['local-mock'].models[0], id: 'second-model' });
  writeJson(join(paths.home, 'models.json'), config);
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const old = runtime.registry.create();
  const other = runtime.registry.create();
  await runtime.runs.send(old.id, 'First');
  const original = await runtime.pi.open(old.id);
  await runtime.updateSettings({ model: { provider: 'local-mock', id: 'second-model' } });
  await runtime.getConversation(old.id);
  assert.equal(runtime.settings.model.id, 'second-model');
  assert.strictEqual(await runtime.pi.open(old.id), original);
  await runtime.runs.send(old.id, 'Switch with SDK');
  assert.equal(mock.requests.at(-1).model, 'second-model');
  await runtime.delegation.run(old.id, 'Child override', { provider: 'local-mock', id: 'mock-model' });
  assert.equal(runtime.settings.model.id, 'second-model');
  await runtime.runs.send(other.id, 'Other conversation');
  assert.equal(mock.requests.at(-1).model, 'second-model');
  await runtime.stop();
  runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  assert.equal(runtime.settings.model.id, 'second-model');
  await runtime.runs.send(old.id, 'After restart');
  assert.equal(mock.requests.at(-1).model, 'second-model');
});

test('appearance, parallelism and child defaults update without interrupting a running session', async (t) => {
  let entered: () => void;
  let release: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async () => { entered(); await held; return 'Done'; });
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { release(); await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const item = runtime.registry.create();
  const pending = runtime.runs.send(item.id, 'Hold');
  await waiting;
  const original = await runtime.pi.open(item.id);
  await runtime.updateSettings({ appearance: 'dark', subagents: { maxParallel: 2 } });
  assert.strictEqual(await runtime.pi.open(item.id), original);
  assert.equal(runtime.delegation.parallelLimit, 2);
  assert.equal(runtime.runs.active(item.id), true);
  await assert.rejects(runtime.updateSettings({ plugins: { files: false } }), /Stop active/);
  await assert.rejects(runtime.updateSettings({ plugins: { 'session-helper': false } }), /Stop active/);
  assert.equal(runtime.settings.plugins['session-helper'], true);
  release();
  assert.equal(await pending, 'Done');
});

test('credential settings persist using Pi and do not return secrets', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const port = await app.listen(0);
  const response = await fetch('http://127.0.0.1:' + port + '/api/credentials', {
    method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'anthropic', key: 'fixture-secret' })
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.doesNotMatch(await response.text(), /fixture-secret/);
  assert.equal(JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8')).anthropic.key, 'fixture-secret');
});

test('tool availability changes rebuild affected sessions and preserve unrelated sessions', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const parent = runtime.registry.create();
  const child = runtime.registry.create({ parentId: parent.id });
  const leaf = runtime.registry.create({ parentId: child.id });
  const originalParent = await runtime.pi.open(parent.id);
  const originalChild = await runtime.pi.open(child.id);
  const originalLeaf = await runtime.pi.open(leaf.id);
  await runtime.updateSettings({ subagents: { maxDepth: 2 } });
  assert.strictEqual(await runtime.pi.open(parent.id), originalParent);
  assert.notStrictEqual(await runtime.pi.open(child.id), originalChild);
  assert.ok((await runtime.pi.open(child.id)).getActiveToolNames().includes('delegate'));
  assert.strictEqual(await runtime.pi.open(leaf.id), originalLeaf);
  await runtime.updateSettings({ plugins: { subagents: false } });
  assert.notStrictEqual(await runtime.pi.open(parent.id), originalParent);
  assert.ok(!(await runtime.pi.open(parent.id)).getActiveToolNames().includes('delegate'));
  assert.strictEqual(await runtime.pi.open(leaf.id), originalLeaf);
  await runtime.updateSettings({ plugins: { skills: false } });
  assert.equal(runtime.plugins.ctx.harnessSkills, undefined);
  assert.notStrictEqual(await runtime.pi.open(leaf.id), originalLeaf);
});
