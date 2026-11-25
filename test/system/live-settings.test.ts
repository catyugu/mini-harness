import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storedProfile } from '../support/profile.js';
import { MiniHarnessRuntime } from '../support/profile.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('appearance, parallelism and child defaults update without interrupting a running session', async (t) => {
  let entered: () => void;
  let release: () => void = () => { throw new Error('Not started'); };
  const waiting = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async () => { entered(); await held; return 'Done'; });
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { release(); await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const item = runtime.plugins.ctx.harnessRegistry.create();
  const pending = runtime.plugins.ctx.harnessRuns.send(item.id, 'Hold');
  await waiting;
  const original = runtime.plugins.ctx.harnessRegistry.log(item.id);
  await runtime.configuration.update({ pluginConfig: { 'core:theme': { appearance: 'dark' }, subagents: { maxParallel: 2 } } });
  assert.equal(runtime.settings.pluginConfig['core:theme'].appearance, 'dark');
  assert.strictEqual(runtime.plugins.ctx.harnessRegistry.log(item.id), original);
  assert.equal(runtime.settings.pluginConfig.subagents.maxParallel, 2);
  assert.equal(runtime.plugins.ctx.harnessRuns.active(item.id), true);
  await assert.rejects(runtime.configuration.update({ pluginConfig: { subagents: { model: { provider: 'missing', id: 'unavailable' } } } }), /Unknown child model/);
  await assert.rejects(runtime.configuration.update({ pluginConfig: { subagents: { model: { provider: 'local-mock', id: 'unavailable' } } } }), /Unknown child model/);
  assert.equal(runtime.settings.pluginConfig.subagents.model, null);
  assert.equal(runtime.settings.pluginConfig.subagents.maxParallel, 2);
  const target = 'session:' + item.id;
  await assert.rejects(runtime.configuration.update({ plugins: { files: false } }), /Stop the affected conversations/);
  assert.equal(runtime.settings.plugins.files, true);
  await runtime.configuration.update({ scopes: { [target]: { disabledTools: ['shell'] } } });
  assert.equal(runtime.plugins.ctx.harnessRuns.active(item.id), true);
  release();
  assert.equal(await pending, 'Done');
  const firstMessage = runtime.plugins.ctx.harnessRegistry.log(item.id).projection().messages[0].id;
  await runtime.configuration.update({ plugins: { files: false, 'session-helper': false } });
  await runtime.plugins.ctx.harnessRuns.send(item.id, 'After the policy changes');
  assert.equal(runtime.plugins.ctx.harnessRegistry.log(item.id).projection().messages[0].id, firstMessage);
  assert.strictEqual(runtime.plugins.ctx.harnessRegistry.log(item.id), original);
  const advertised = mock.requests.at(-1)?.tools as { function: { name: string } }[];
  assert.equal(advertised.some(({ function: tool }) => tool.name === 'read'), false);
  assert.ok(!runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name).includes('read'));
});

test('a scoped plugin transaction excludes new runs in its subtree until commit', { timeout: 10000 }, async (t) => {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  const key = Symbol.for('mini-harness-test-admission');
  const shared = globalThis as typeof globalThis & Record<symbol, (() => Promise<void>) | undefined>;
  shared[key] = () => { enter(); return hold; };
  t.after(async () => { release(); delete shared[key]; await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'staged');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ scope: 'workspace' }));
  writeFileSync(join(folder, 'plugin.js'), "export default () => globalThis[Symbol.for('mini-harness-test-admission')]();");
  await runtime.start();
  const target = runtime.plugins.ctx.harnessRegistry.create();
  const obsolete = runtime.plugins.ctx.harnessRegistry.create();
  const obsoleteScope = `session:${obsolete.id}` as const;
  const obsoleteConfig = { disabledTools: ['shell'] };
  await runtime.configuration.update({ scopes: { [obsoleteScope]: obsoleteConfig } });
  const otherDirectory = join(root, 'other');
  mkdirSync(otherDirectory);
  const otherWorkspace = runtime.plugins.ctx.harnessWorkspaces.register(otherDirectory);
  const other = runtime.plugins.ctx.harnessRegistry.create({ workspaceId: otherWorkspace.id });
  const workspace = `workspace:${target.workspaceId}` as const;
  const updating = runtime.configuration.update({ scopes: {
    [workspace]: { plugins: { staged: true } },
    [obsoleteScope]: obsoleteConfig
  } });
  let sibling: Promise<string>;
  let deletion: Promise<string[]>;
  try {
    await entered;
    assert.throws(() => runtime.plugins.ctx.harnessRuns.startRun(target.id, 'Cannot cross the transaction'), /configuration is changing/);
    assert.equal(runtime.plugins.ctx.harnessRuns.info(target.id), undefined);
    sibling = runtime.plugins.ctx.harnessRuns.send(other.id, 'Unaffected workspace');
    deletion = runtime.plugins.ctx.harnessRegistry.delete([obsolete.id]);
  } finally { release(); }
  await updating;
  assert.deepEqual(await deletion, [obsolete.id]);
  assert.equal((await storedProfile(paths)).scopes[obsoleteScope], undefined);
  assert.equal((await storedProfile(paths)).scopes[workspace]?.plugins?.staged, true);
  assert.equal(await sibling, 'Mock response');
  assert.equal(await runtime.plugins.ctx.harnessRuns.send(target.id, 'After commit'), 'Mock response');
});
