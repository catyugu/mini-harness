import { sendRun } from '../support/runs.ts';
import { isViewMessage } from '@mini-harness/sessions/message';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storedProfile } from '../support/profile.ts';
import { MiniHarnessRuntime } from '../support/profile.ts';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';

test('appearance, parallelism and child defaults update without interrupting a running session', async (t) => {
  let entered: () => void;
  let release: () => void = () => {
    throw new Error('Not started');
  };
  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const mock = await createMockProvider(async () => {
    entered();
    await held;
    return 'Done';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    release();
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const item = runtime.plugins.ctx.harnessSessions.create();
  const pending = sendRun(runtime.plugins.ctx.harnessRuns, item.id, 'Hold');
  await waiting;
  const original = runtime.plugins.ctx.harnessSessions.log(item.id);
  await runtime.configuration.update({
    entries: { 'core:theme': { config: { appearance: 'dark' } }, subagents: { config: { maxParallel: 2 } } },
  });
  assert.equal(runtime.settings.entries['core:theme']?.config?.appearance, 'dark');
  assert.strictEqual(runtime.plugins.ctx.harnessSessions.log(item.id), original);
  assert.equal(runtime.settings.entries.subagents?.config?.maxParallel, 2);
  assert.equal(Boolean(runtime.plugins.ctx.harnessRuns.current(item.id)), true);
  await assert.rejects(
    runtime.configuration.update({
      entries: { subagents: { config: { model: { provider: 'missing', id: 'unavailable' } } } },
    }),
    /Unknown child model/,
  );
  await assert.rejects(
    runtime.configuration.update({
      entries: { subagents: { config: { model: { provider: 'local-mock', id: 'unavailable' } } } },
    }),
    /Unknown child model/,
  );
  assert.equal(runtime.settings.entries.subagents?.config?.model, undefined);
  assert.equal(runtime.settings.entries.subagents?.config?.maxParallel, 2);
  await runtime.configuration.update({ entries: { files: { disabled: true } } });
  assert.equal(runtime.settings.entries.files?.disabled, true);
  assert.equal(Boolean(runtime.plugins.ctx.harnessRuns.current(item.id)), true);
  release();
  assert.equal(await pending, 'Done');
  const firstMessage = runtime.plugins.ctx.harnessSessions
    .log(item.id)
    .projection()
    .timeline.filter(isViewMessage)[0].id;
  await runtime.configuration.update({
    entries: { files: { disabled: true }, 'session-helper': { disabled: true } },
  });
  await sendRun(runtime.plugins.ctx.harnessRuns, item.id, 'After the policy changes');
  assert.equal(
    runtime.plugins.ctx.harnessSessions.log(item.id).projection().timeline.filter(isViewMessage)[0].id,
    firstMessage,
  );
  assert.strictEqual(runtime.plugins.ctx.harnessSessions.log(item.id), original);
  const advertised = mock.requests.at(-1)?.tools as { function: { name: string } }[];
  assert.equal(
    advertised.some(({ function: tool }) => tool.name === 'read'),
    false,
  );
  assert.ok(
    !runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .map(({ name }) => name)
      .includes('read'),
  );
});

test(
  'a run waits for scoped composition while another scope can be removed',
  { timeout: 10000 },
  async (t) => {
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = await createMockProvider();
    const { root, paths } = createFixturePaths(mock.url);
    const runtime = new MiniHarnessRuntime(paths);
    const key = Symbol.for('mini-harness-test-admission');
    const shared = globalThis as typeof globalThis & Record<symbol, (() => Promise<void>) | undefined>;
    shared[key] = () => {
      enter();
      return hold;
    };
    t.after(async () => {
      release();
      delete shared[key];
      await runtime.stop();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    const folder = join(paths.plugins, 'staged');
    mkdirSync(folder);
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
    writeFileSync(
      join(folder, 'plugin.js'),
      "export default () => globalThis[Symbol.for('mini-harness-test-admission')]();",
    );
    await runtime.start();
    const target = runtime.plugins.ctx.harnessSessions.create();
    const obsolete = runtime.plugins.ctx.harnessSessions.create();
    const obsoleteScope = `session:${obsolete.id}` as const;
    const obsoleteConfig = { entries: {} };
    await runtime.configuration.update({ scopes: { [obsoleteScope]: obsoleteConfig } });
    const otherDirectory = join(root, 'other');
    mkdirSync(otherDirectory);
    const otherWorkspace = runtime.plugins.ctx.harnessWorkspaces.register(otherDirectory);
    const other = runtime.plugins.ctx.harnessSessions.create({ workspaceId: otherWorkspace.id });
    const workspace = `workspace:${target.workspaceId}` as const;
    const updating = runtime.configuration.update({
      scopes: {
        [workspace]: { entries: { staged: { name: '../../plugins/staged', disabled: false } } },
        [obsoleteScope]: obsoleteConfig,
      },
    });
    let targetRun: Promise<string>;
    let sibling: Promise<string>;
    let deletion: Promise<string[]>;
    try {
      await entered;
      targetRun = sendRun(runtime.plugins.ctx.harnessRuns, target.id, 'Wait for the new composition');
      assert.equal(runtime.plugins.ctx.harnessRuns.info(target.id)?.state, 'queued');
      sibling = sendRun(runtime.plugins.ctx.harnessRuns, other.id, 'Unaffected workspace');
      deletion = runtime.plugins.ctx.harnessSessions.delete([obsolete.id]);
    } finally {
      release();
    }
    await updating;
    assert.deepEqual(await deletion, [obsolete.id]);
    assert.equal((await storedProfile(paths)).scopes[obsoleteScope], undefined);
    assert.equal((await storedProfile(paths)).scopes[workspace]?.entries?.staged?.disabled, false);
    assert.equal(await sibling, 'Mock response');
    assert.equal(await targetRun, 'Mock response');
  },
);
