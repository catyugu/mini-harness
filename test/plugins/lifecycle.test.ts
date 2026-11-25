import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { fixture, waitUntil } from '../support/api-fixture.ts';
import { writePlugin } from '../support/plugin-fixture.ts';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime, storedProfile } from '../support/profile.ts';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.ts';
import { DEFAULTS, mergeSettings } from '@mini-harness/plugin-api/selection';
import { writeJson } from '@mini-harness/platform/json';

import { Context, type Plugin } from 'mini-harness/cordis';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { PluginHost } from '@mini-harness/plugins/manager';
import { createScopeKey, scopeChainOf, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';

declare module 'mini-harness/cordis' {
  interface Context {
    greeting: string;
    extra: string;
  }
}

function fixtureKeys() {
  const keys = new Map<string, ScopeKey>();
  return (id: string, parent?: ScopeKey) => {
    let key = keys.get(id);
    if (!key) keys.set(id, (key = createScopeKey(parent)));
    return key;
  };
}

type FixtureModule = PluginInfo & { id: string; plugin?: Plugin };

function fixtureProfile(
  directory: string,
  modules: FixtureModule[],
  read: () => typeof DEFAULTS,
  commit = (_next: typeof DEFAULTS) => {},
) {
  const locations = new Map<string, { folder: string; entry: string }>();
  for (const { id, plugin, ...metadata } of modules) {
    const folder = join(directory, id);
    mkdirSync(folder, { recursive: true });
    const entry = join(folder, 'plugin.mjs');
    const key = entry;
    Object.defineProperty(globalThis, key, { configurable: true, value: plugin });
    if (metadata.browser) {
      metadata.browser = 'web.js';
      writeFileSync(join(folder, 'web.js'), 'export function apply() {}');
    }
    writeFileSync(
      entry,
      'export const metadata = ' +
        JSON.stringify(metadata) +
        '; export default globalThis[' +
        JSON.stringify(key) +
        ']; delete globalThis[' +
        JSON.stringify(key) +
        '];',
    );
    locations.set(id, { folder, entry });
  }
  return {
    read,
    commit,
    locate: (name: string) => locations.get(name),
    source: () => {
      throw new Error('Unknown test module');
    },
  };
}

test('an installed Cordis plugin can use services, configure a tool, and release resources', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });

  const folder = join(paths.plugins, 'example');
  const log = join(folder, 'effects.log');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'schema.json'),
    JSON.stringify({
      type: 'object',
      properties: { prefix: { type: 'string', default: 'Count' } },
    }),
  );
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      title: 'Example plugin',
      icon: {
        path: 'M2 2h20v20H2z',
        viewBox: '0 0 24 24',
      },
    }),
  );
  writeFileSync(
    join(folder, 'plugin.js'),
    `
import { defineConfig } from 'mini-harness/configuration';
import { readFileSync } from 'node:fs';
export const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));
export const inject = ["harnessSessions","harnessTools"];

import { appendFileSync } from 'node:fs';
import { Context } from 'mini-harness/cordis';
export const apply = (ctx, config) => {
      if (!(ctx instanceof Context)) throw new Error('Plugin loaded a different Cordis runtime');
      const sessions = ctx.harnessSessions;
      ctx.effect(() => () => appendFileSync(${JSON.stringify(log)}, 'dispose\\n'));
      ctx.effect(() => ctx.harnessTools.register({
        name: 'example_count', label: 'Count', description: 'Count sessions',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: config.prefix + ': ' + sessions.list().length }] };
        }
      }));
    };
`,
  );
  await runtime.start();
  const item = runtime.plugins.ctx.harnessSessions.create();
  assert.equal(
    runtime.plugins.metadata().find(({ id }) => id === 'example'),
    undefined,
  );
  await runtime.configuration.update({
    entries: { example: { name: '../../plugins/example', disabled: false, config: { prefix: 'Total' } } },
  });
  assert.equal(runtime.plugins.metadata().find(({ id }) => id === 'example')?.title, 'Example plugin');
  assert.deepEqual(runtime.plugins.metadata().find(({ id }) => id === 'example')?.icon, {
    path: 'M2 2h20v20H2z',
    viewBox: '0 0 24 24',
  });
  await runtime.plugins.prepare(`session:${item.id}`);
  const activeNames = () =>
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .map(({ name }) => name);
  assert.ok(activeNames().includes('example_count'));
  const tool = expectPresent(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .find(({ name }) => name === 'example_count'),
    'example count tool',
  );
  assert.equal((await tool.execute('test', {})).content[0].type, 'text');
  assert.match(JSON.stringify(await tool.execute('test', {})), /Total: 1/);
  await assert.rejects(
    runtime.configuration.update({ entries: { example: { config: { prefix: 12 } } } }),
    /Invalid configuration/,
  );
  assert.equal(runtime.settings.entries.example?.config?.prefix, 'Total');
  await runtime.plugins.prepare(`session:${item.id}`);
  assert.match(JSON.stringify(await tool.execute('after-invalid-config', {})), /Total: 1/);
  assert.equal(activeNames().filter((name) => name === 'example_count').length, 1);
  await runtime.configuration.update({ entries: { shell: { disabled: false } } });
  assert.throws(
    () => readFileSync(log),
    { code: 'ENOENT' },
    'Unrelated switches and invalid config preserve an active plugin',
  );
  await runtime.configuration.update({
    entries: { example: { name: '../../plugins/example', disabled: true } },
  });
  assert.equal(readFileSync(log, 'utf8'), 'dispose\n');
  assert.ok(!activeNames().includes('example_count'));
  await assert.rejects(tool.execute('after-unload', {}), /no longer available/);
  await runtime.configuration.update({
    entries: { example: { name: '../../plugins/example', disabled: false } },
  });
  assert.ok(activeNames().includes('example_count'));
});

test('file tools and dependent services follow their Cordis lifetimes', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  writePlugin(
    paths.plugins,
    'base',
    {},
    `export const provide = ['fixtureGreeting']; export const apply = (ctx) => ctx.provide('fixtureGreeting', 'ok');`,
  );
  const folder = join(paths.plugins, 'dependent');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
  writeFileSync(
    join(folder, 'plugin.js'),
    `
export const inject = ["harnessTools", "fixtureGreeting"];

export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessTools.register({ name: 'dependent_tool', description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: ctx.fixtureGreeting }] }) }));
  };
`,
  );
  await runtime.start();
  const item = runtime.plugins.ctx.harnessSessions.create();
  await runtime.plugins.prepare(`session:${item.id}`);
  const activeNames = () =>
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .map(({ name }) => name);
  assert.ok(activeNames().includes('read'));
  await runtime.configuration.update({ entries: { files: { disabled: true } } });
  assert.ok(!activeNames().includes('read'));
  await runtime.configuration.update({
    entries: { files: { disabled: false }, dependent: { name: '../../plugins/dependent', disabled: false } },
  });
  assert.ok(!activeNames().includes('dependent_tool'));
  await runtime.configuration.update({ entries: { base: { name: '../../plugins/base', disabled: false } } });
  assert.ok(activeNames().includes('dependent_tool'));
  await runtime.configuration.update({ entries: { base: { name: '../../plugins/base', disabled: true } } });
  assert.ok(!activeNames().includes('dependent_tool'));
  assert.ok(activeNames().includes('read'));
  await runtime.configuration.update({ entries: { base: { name: '../../plugins/base', disabled: false } } });
  assert.ok(activeNames().includes('dependent_tool'));
  await runtime.configuration.update({
    entries: {
      files: { disabled: true },
      base: { name: '../../plugins/base', disabled: true },
      dependent: { name: '../../plugins/dependent', disabled: true },
    },
  });
  assert.equal(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .some(({ name }) => name === 'read' || name === 'dependent_tool'),
    false,
  );
});

test('server entries support named Cordis declarations and reject an invalid module', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const [id, source] of [
    [
      'function-entry',
      `
export const inject = ["harnessSessions"];

export function apply(ctx) {
      if (ctx.harnessSessions.list().length !== 0) throw new Error('Unexpected sessions');
    }
`,
    ],
    ['named-entry', 'export const setup = () => {}'],
  ]) {
    mkdirSync(join(paths.plugins, id));
    writeFileSync(join(paths.plugins, id, 'plugin.js'), source);
    writeFileSync(join(paths.plugins, id, 'plugin.json'), JSON.stringify({}));
  }
  await runtime.start();
  await runtime.configuration.update({
    entries: { 'function-entry': { name: '../../plugins/function-entry', disabled: false } },
  });
  await assert.rejects(
    runtime.configuration.update({
      entries: { 'named-entry': { name: '../../plugins/named-entry', disabled: false } },
    }),
    /must export a Cordis plugin/,
  );
  assert.equal(runtime.settings.entries['function-entry']?.disabled, false);
  assert.equal(runtime.settings.entries['named-entry']?.disabled, undefined);
  assert.equal((await storedProfile(paths)).entries['named-entry']?.disabled, undefined);
});

test('native Cordis Config applies defaults and rejects invalid changes before setup', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const folder = join(paths.plugins, 'schema');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'schema.json'),
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
        options: {
          type: 'object',
          default: {},
          properties: { enabled: { type: 'boolean', default: true } },
        },
      },
    }),
  );
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
  writeFileSync(
    join(folder, 'plugin.js'),
    `
export const inject = ["harnessPluginSettings","harnessTools"];

import { defineConfig } from 'mini-harness/configuration';
import { readFileSync } from 'node:fs';
export const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')), (config) => config.count === 5 ? 'Five is reserved' : undefined);

export const apply = (ctx) => {
    const changes = [];
    ctx.harnessPluginSettings.subscribe('count', (value) => changes.push(value));
    ctx.effect(() => ctx.harnessTools.register({ name: 'schema_value', description: 'Fixture', parameters: { type: 'object', properties: {} },
      async execute(_id, changesToSave) {
        if (Object.keys(changesToSave).length) await ctx.harnessPluginSettings.patch(changesToSave);
        return { content: [{ type: 'text', text: ctx.harnessPluginSettings.get('count') + ':' +
          ctx.harnessPluginSettings.get('options').enabled + ':' + changes.join(',') }] };
      }
    }));
  };
`,
  );
  await runtime.start();
  await runtime.configuration.update({
    entries: { schema: { name: '../../plugins/schema', disabled: false, live: true } },
  });
  const item = runtime.plugins.ctx.harnessSessions.create();
  const tool = expectPresent(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .find(({ name }) => name === 'schema_value'),
    'schema tool',
  );
  assert.match(JSON.stringify(await tool.execute('test', {})), /3:true/);
  await Promise.all([
    tool.execute('set-count', { count: 7 }),
    tool.execute('set-options', { options: { enabled: false } }),
  ]);
  assert.deepEqual((await storedProfile(paths)).entries.schema?.config, {
    count: 7,
    options: { enabled: false },
  });
  await assert.rejects(tool.execute('rejected-semantics', { count: 5 }), /Five is reserved/);
  assert.deepEqual((await storedProfile(paths)).entries.schema?.config, {
    count: 7,
    options: { enabled: false },
  });
  await assert.rejects(tool.execute('invalid-count', { count: 0 }), /Invalid configuration/);
  assert.match(JSON.stringify(await tool.execute('committed', {})), /7:false:7/);
  await assert.rejects(
    runtime.configuration.update({ entries: { schema: { config: { count: 0 } } } }),
    /Invalid configuration/,
  );
  assert.deepEqual(
    await tool.execute('test', {}),
    await expectPresent(
      runtime.plugins.ctx.harnessTools
        .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
        .find(({ name }) => name === 'schema_value'),
      'registered schema tool',
    ).execute('test', {}),
  );
});

test('dependent plugins restart in order and partial setup or persistence failures restore their resources', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const log = join(paths.plugins, 'lifecycle.log');
  for (const id of ['base', 'dependent']) {
    const folder = join(paths.plugins, id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
    writeFileSync(
      join(folder, 'plugin.js'),
      `
export const inject = ${JSON.stringify(id === 'dependent' ? ['harnessTools', 'fixtureBase'] : ['harnessTools'])};
export const provide = ${JSON.stringify(id === 'base' ? ['fixtureBase'] : [])};

import { appendFileSync } from 'node:fs';
export const apply = (ctx, config) => {
        appendFileSync(${JSON.stringify(log)}, 'start ${id}\\n');
        ctx.effect(() => () => appendFileSync(${JSON.stringify(log)}, 'stop ${id}\\n'));
        ctx.effect(() => ctx.harnessTools.register({ name: '${id}_tool', description: 'Fixture', parameters: {type: 'object', properties: {}},
          execute: async () => ({content: [{type: 'text', text: String(config.value ?? 'original')}]}) }));
        if (config.fail) throw new Error('Partial setup failed');
        if ('${id}' === 'base') ctx.provide('fixtureBase', config.value ?? 'original');
      };
`,
    );
  }
  await runtime.start();
  await runtime.configuration.update({
    entries: {
      base: { name: '../../plugins/base', disabled: false },
      dependent: { name: '../../plugins/dependent', disabled: false },
    },
  });
  await assert.rejects(
    runtime.configuration.update({ entries: { base: { config: { fail: true } } } }),
    /Partial setup failed/,
  );
  assert.match(
    readFileSync(log, 'utf8'),
    /stop dependent\nstop base\nstart base\nstop base\nstart base\nstart dependent/,
  );
  const item = runtime.plugins.ctx.harnessSessions.create();
  assert.equal(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .filter(({ name }) => name === 'base_tool').length,
    1,
  );
  const profile = runtime.plugins.ctx.harnessProfile;
  const commit = profile.commit;
  profile.commit = () => {
    throw new Error('Persistence failed');
  };
  try {
    await assert.rejects(
      runtime.configuration.update({ entries: { base: { config: { value: 'replacement' } } } }),
      /Persistence failed/,
    );
  } finally {
    profile.commit = commit;
  }
  const restored = expectPresent(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .find(({ name }) => name === 'base_tool'),
    'restored tool',
  );
  assert.match(JSON.stringify(await restored.execute('test', {})), /original/);
  assert.ok(
    runtime.plugins.ctx.harnessTools
      .list({ resourceId: item.id, scope: runtime.plugins.ctx.harnessSessions.runScope(item.id) })
      .some(({ name }) => name === 'dependent_tool'),
  );
});

test('cyclic services stay waiting without activating either plugin', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const [id, dependency] of [
    ['first', 'second'],
    ['second', 'first'],
  ]) {
    const folder = join(paths.plugins, id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
    writeFileSync(
      join(folder, 'plugin.js'),
      `export const inject = [${JSON.stringify(dependency)}]; export const provide = [${JSON.stringify(id)}]; export function apply() { throw new Error('Should not mount'); }`,
    );
  }
  await runtime.start();
  await runtime.configuration.update({
    entries: {
      first: { name: '../../plugins/first', disabled: false },
      second: { name: '../../plugins/second', disabled: false },
    },
  });
  assert.equal(runtime.settings.entries.first?.disabled, false);
  for (const id of ['first', 'second'])
    assert.equal(runtime.plugins.metadata().find((plugin) => plugin.id === id)?.state, 'inactive');
});

test('malformed plugin metadata is diagnosed when explicitly declared', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const folder = join(paths.plugins, 'broken-manifest');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default () => {};');
  writeFileSync(join(folder, 'plugin.json'), '{"requires": [');
  await runtime.start();
  assert.equal(
    runtime.plugins.metadata().find(({ id }) => id === 'broken-manifest'),
    undefined,
  );
  await assert.rejects(
    runtime.configuration.update({
      entries: { 'broken-manifest': { name: '../../plugins/broken-manifest', disabled: false } },
    }),
    /Invalid plugin/,
  );
  assert.equal(runtime.settings.entries['broken-manifest']?.disabled, undefined);
});

test('disabled optional builtins cannot block boot or reload because their config is malformed', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'subagents', disabled: true, config: { maxDepth: 100 } }],
  });
  const restored = new MiniHarnessRuntime(paths);
  t.after(() => restored.stop());
  await restored.start();
  assert.match(
    restored.plugins.metadata().find(({ id }) => id === 'subagents')?.error ?? '',
    /Invalid configuration/,
  );
  await restored.configuration.update({ entries: { subagents: { config: { maxDepth: 101 } } } });
  await assert.rejects(
    restored.configuration.update({ entries: { subagents: { disabled: false } } }),
    /Invalid configuration/,
  );
  await restored.configuration.update({
    entries: { subagents: { config: { maxDepth: 2, model: { provider: 'unknown', id: 'missing' } } } },
  });
  await assert.rejects(
    restored.configuration.update({ entries: { subagents: { disabled: false } } }),
    /Unknown child model/,
  );
  await restored.configuration.update({ entries: { 'core:theme': { config: { appearance: 'dark' } } } });
  const conversation = restored.plugins.ctx.harnessSessions.create();
  assert.equal(
    await restored.plugins.ctx.harnessRuns.send(conversation.id, 'Main agent still works'),
    'Mock response',
  );
  await restored.configuration.update({
    entries: { subagents: { disabled: false, config: { maxDepth: 2 } } },
  });
  assert.ok(
    restored.plugins.ctx.harnessTools
      .list({
        resourceId: conversation.id,
        scope: restored.plugins.ctx.harnessSessions.runScope(conversation.id),
      })
      .some(({ name }) => name === 'delegate'),
  );
});

test('an optional plugin that fails at startup reports its state without blocking other capabilities', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'fails-to-start');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), "export default () => { throw new Error('Startup failed'); };");
  writeFileSync(join(folder, 'web.js'), 'export default () => {};');
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'fails-to-start', name: '../../plugins/fails-to-start', client: true }],
  });
  const restarted = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await restarted.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await restarted.start();
  const status = expectPresent(
    restarted.plugins.metadata().find(({ id }) => id === 'fails-to-start'),
    'failed plugin',
  );
  assert.equal(status.state, 'failed');
  assert.match(expectPresent(status.error, 'startup error'), /Startup failed/);
  assert.ok(!restarted.plugins.browser().some(({ id }) => id === status.id));
  await restarted.configuration.update({ entries: { 'core:theme': { config: { appearance: 'dark' } } } });
  assert.equal(restarted.settings.entries['core:theme']?.config?.appearance, 'dark');
  await restarted.configuration.update({ entries: { 'fails-to-start': { disabled: true } } });
  assert.equal(
    expectPresent(
      restarted.plugins.metadata().find(({ id }) => id === status.id),
      'disabled plugin metadata',
    ).state,
    'disabled',
  );
});

test('ordinary routes and upgrades drain on unload and can request their own removal', async (t) => {
  const { app, base, headers, paths, root, request } = await fixture(t);
  const trace = join(root, 'calls');
  const lifecycle = `
    import { appendFileSync } from 'node:fs';
    const mark = (value) => appendFileSync(${JSON.stringify(trace)}, value + '\\n');
    const wait = async (name, signal) => {
      mark(name + ':entered');
      await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      await new Promise((done) => setImmediate(done));
      mark(name + ':drained');
    };
  `;
  writePlugin(
    paths.plugins,
    'drain',
    {},
    lifecycle +
      `
export const inject = ["harnessRoutes","harnessUpgrades","harnessProfileConfig"];
export const apply = (ctx) => {
      ctx.effect(() => {
        const routes = ctx.harnessRoutes;
        const dispose = [
          routes.register('GET', '/api/extensions/drain/wait', ({ signal }) => wait('http', signal)),
          routes.register('POST', '/api/extensions/drain/body', async ({ body }) => {
            mark('body:entered');
            try { return await body(); }
            finally { mark('body:drained'); }
          }),
          routes.register('POST', '/api/extensions/drain/disable', async ({ signal }) => {
            await ctx.harnessProfileConfig.update({ entries: { drain: { name: '../../plugins/drain', disabled: true } } }, signal);
            return { disabled: true };
          }),
          ctx.harnessUpgrades.register('/api/extensions/drain/socket', async (_request, _socket, _head, signal) => wait('ws', signal)),
        ];
        return async () => {
          await Promise.all(dispose.map(fn => fn()));
          mark('app:disposed');
        };
      });
    };
`,
  );
  writePlugin(
    paths.plugins,
    'scoped-drain',
    {},
    lifecycle +
      `
export const inject = ["harnessRoutes"];
export const apply = (ctx) => {
      ctx.effect(() => {
        const dispose = ctx.harnessRoutes.register('POST', '/api/scoped-drain/wait', ({ signal }) => wait('scope', signal));
        return async () => {
          await dispose();
          mark('scope:disposed');
        };
      });
    };
`,
  );
  const session = app.runtime.plugins.ctx.harnessSessions.create();
  const scope = `session:${session.id}` as const;
  const toggle = (active: boolean) =>
    request('/settings', 'PATCH', {
      entries: { drain: { name: '../../plugins/drain', disabled: !active } },
      scopes: {
        [scope]: { entries: { 'scoped-drain': { name: '../../plugins/scoped-drain', disabled: !active } } },
      },
    });
  assert.equal((await toggle(true)).status, 200);
  await app.runtime.plugins.prepare(scope);
  const current = request('/extensions/drain/wait');
  const currentScope = request('/scoped-drain/wait', 'POST', {});
  const bodyStatus = new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      base + '/api/extensions/drain/body',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': '20' },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
        request.destroy();
      },
    );
    request.once('error', reject);
    request.write('{"partial":');
  });
  const closed = new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      base + '/api/extensions/drain/socket',
      {
        headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket' },
      },
      (response) => {
        response.resume();
        reject(new Error('Unexpected upgrade response ' + response.statusCode));
      },
    );
    request.once('error', (error) =>
      'code' in error && error.code === 'ECONNRESET' ? resolve() : reject(error),
    );
    request.end();
  });
  try {
    await waitUntil(
      () => (existsSync(trace) ? readFileSync(trace, 'utf8') : ''),
      (log) =>
        ['http:entered', 'ws:entered', 'scope:entered', 'body:entered'].every((entry) => log.includes(entry)),
    );
  } finally {
    assert.equal((await toggle(false)).status, 200);
  }
  const log = readFileSync(trace, 'utf8').split('\n');
  for (const [name, disposal] of [
    ['http', 'app'],
    ['ws', 'app'],
    ['scope', 'scope'],
    ['body', 'app'],
  ]) {
    const drained = log.indexOf(name + ':drained');
    assert.ok(
      drained > log.indexOf(name + ':entered') && drained < log.indexOf(disposal + ':disposed'),
      log.join(', '),
    );
  }
  await closed;
  assert.equal((await current).status, 400);
  assert.equal(await bodyStatus, 400);
  assert.equal((await currentScope).status, 400);
  assert.equal((await request('/extensions/drain/wait')).status, 404);
  assert.equal((await request('/scoped-drain/wait', 'POST', {})).status, 404);
  assert.equal((await toggle(true)).status, 200);
  const removed = await request('/extensions/drain/disable', 'POST');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.disabled, true);
  assert.equal(app.runtime.settings.entries.drain?.disabled, true);
  assert.equal((await request('/extensions/drain/disable', 'POST')).status, 404);
});

test('live scoped providers isolate siblings, restore inheritance and roll back failed setup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-live-scopes-'));
  const workspaceId = 'a'.repeat(32),
    otherWorkspace = 'b'.repeat(32);
  const records = new Map<string, SessionRecord>([
    ['parent', { id: 'parent', workspaceId, parentId: null } as SessionRecord],
    ['child', { id: 'child', workspaceId, parentId: 'parent' } as SessionRecord],
    ['sibling', { id: 'sibling', workspaceId, parentId: null } as SessionRecord],
    ['independent', { id: 'independent', workspaceId: otherWorkspace, parentId: null } as SessionRecord],
  ]);
  const released: string[] = [];
  const builtins: FixtureModule[] = [
    {
      id: 'global',
      title: 'Global',
      description: '',
      plugin: {
        provide: ['greeting', 'extra'],
        apply(ctx) {
          ctx.provide('greeting', 'global');
          ctx.provide('extra', 'retained');
        },
      },
    },
    {
      id: 'workspace',
      title: 'Workspace',
      description: '',
      plugin: {
        Config: defineConfig({
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        }),
        provide: 'greeting',
        apply(ctx: Context, config: Record<string, unknown>) {
          ctx.provide('greeting', String(config.value));
        },
      },
    },
    {
      id: 'layer',
      title: 'Layer',
      description: '',
      plugin: {
        provide: 'greeting',
        apply(ctx: Context, config: Record<string, unknown>) {
          ctx.effect(() => () => {
            released.push(String(config.value));
          });
          if (config.fail) throw new Error('Scoped setup failed');
          ctx.provide('greeting', String(config.value));
        },
      },
    },
  ];
  const workspaceKey = 'workspace:' + workspaceId;
  const workspace = {
    isolate: ['greeting'],
    entries: { workspace: { name: 'workspace', disabled: false, config: { value: 'workspace' } } },
  };
  let settings: typeof DEFAULTS = {
    ...structuredClone(DEFAULTS),
    entries: { global: { name: 'global' } },
    scopes: {
      [workspaceKey]: {
        ...workspace,
        entries: { workspace: { name: 'workspace', disabled: false, config: { value: 42 } } },
      },
    },
  };
  const ctx = new Context();
  ctx.provide('authority', {});
  const host = new PluginHost(
    ctx,
    directory,
    fixtureProfile(
      directory,
      builtins,
      () => settings,
      (next) => {
        settings = next;
      },
    ),
  );
  const workspaceKeys = fixtureKeys();
  host.register('workspace', (id) => ({ key: workspaceKeys(id) }), true);
  const sessionKeys = fixtureKeys();
  host.register('session', (id) => {
    const record = records.get(id);
    return (
      record && {
        key: sessionKeys(id),
        parent: record.parentId ? `session:${record.parentId}` : `workspace:${record.workspaceId}`,
      }
    );
  });
  t.after(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await host.start();
  assert.equal(host.metadata().find(({ id }) => id === 'workspace')?.state, 'failed');
  assert.throws(() => host.require('session:sibling', 'greeting'), /Invalid configuration/);
  assert.equal(host.require('session:independent', 'greeting'), 'global');
  const configure = (scopes: typeof settings.scopes) => {
    const next = { ...settings, scopes };
    return host.update(next);
  };
  const parent = {
    isolate: ['greeting'],
    entries: { layer: { name: 'layer', disabled: false, config: { value: 'parent' } } },
  };
  const child = {
    isolate: ['greeting'],
    entries: { layer: { name: 'layer', disabled: false, config: { value: 'child' } } },
  };
  const broken = {
    ...parent,
    entries: { layer: { name: 'layer', disabled: false, config: { fail: true } } },
  };
  await assert.rejects(
    configure({
      [workspaceKey]: workspace,
      'session:parent': parent,
      'session:child': child,
      'session:sibling': broken,
    }),
    /Scoped setup failed/,
  );
  assert.ok(!Object.hasOwn(settings.scopes, 'session:sibling'));
  await configure({ [workspaceKey]: workspace, 'session:parent': parent, 'session:child': child });
  assert.equal(
    host.metadata().find(({ id }) => id === 'layer')?.state,
    'ready',
    'changed scoped entries are mounted before commit',
  );
  assert.equal(host.require('session:parent', 'greeting'), 'parent');
  assert.equal(host.require('session:child', 'greeting'), 'child');
  assert.equal(host.require('session:sibling', 'greeting'), 'workspace');
  assert.equal(host.require('session:independent', 'greeting'), 'global');
  await configure({
    ...settings.scopes,
    'session:sibling': {
      ...parent,
      entries: { layer: { name: 'layer', disabled: false, config: { value: 'fixed' } } },
    },
  });
  assert.equal(host.require('session:sibling', 'greeting'), 'fixed');
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'ready');
  assert.equal(host.require('session:child', 'extra'), 'retained');
  await assert.rejects(
    configure({
      ...settings.scopes,
      'session:parent': {
        ...parent,
        entries: { layer: { name: 'layer', disabled: false, config: { value: 'broken', fail: true } } },
      },
    }),
    /Scoped setup failed/,
  );
  assert.equal(host.require('session:child', 'greeting'), 'child');
  assert.equal(host.require('session:parent', 'greeting'), 'parent');
  assert.ok(released.includes('broken'));

  // An empty scope must not retain a stale service isolation.
  await configure({ 'session:parent': parent, 'session:child': {} });
  assert.equal(host.require('session:child', 'greeting'), 'parent');

  // Adding a configured ancestor of an already mounted child must mount that ancestor immediately.
  await configure({ [workspaceKey]: workspace, 'session:child': {} });
  assert.equal(host.require('session:child', 'greeting'), 'workspace');
  assert.equal(host.require('session:sibling', 'greeting'), 'workspace');
  assert.equal(ctx.get('greeting'), 'global');
  await configure({});
  assert.equal(host.require('session:child', 'greeting'), 'global');
});

test('configuration validation resolves the staged scope provider and rejects invalid writes atomically', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-validate-scope-'));
  const workspaceId = 'a'.repeat(32);
  const key = 'workspace:' + workspaceId;
  let settings: import('@mini-harness/plugin-api/configuration').ProfileConfiguration = {
    ...structuredClone(DEFAULTS),
    entries: { global: { name: 'global' } },
  };
  const builtins: FixtureModule[] = [
    {
      id: 'global',
      title: 'Default',
      description: '',
      plugin: {
        provide: 'greeting',
        apply(ctx) {
          ctx.provide('greeting', 'global');
        },
      },
    },
    {
      id: 'local',
      title: 'Local',
      description: '',
      plugin: {
        provide: 'greeting',
        apply(ctx) {
          ctx.provide('greeting', 'local');
        },
      },
    },
    {
      id: 'consumer',
      title: 'Consumer',
      description: '',
      plugin: {
        inject: ['greeting'],
        Config: defineConfig({
          type: 'object',
          properties: { expected: { type: 'string' } },
          required: ['expected'],
        }),
        apply(ctx: Context, config: Record<string, unknown>) {
          if (config.expected !== ctx.get('greeting')) throw new Error('Wrong scoped greeting');
        },
      },
    },
  ];
  const host = new PluginHost(
    new Context(),
    directory,
    fixtureProfile(
      directory,
      builtins,
      () => settings,
      (next) => {
        settings = next;
      },
    ),
  );
  const workspaceKeys = fixtureKeys();
  host.register('workspace', (id) => ({ key: workspaceKeys(id) }), true);
  t.after(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await host.start();
  const configure = (expected: string) => {
    const next = {
      ...settings,
      scopes: {
        [key]: {
          isolate: ['greeting'],
          entries: {
            consumer: { name: 'consumer', disabled: false, config: { expected } },
            local: { name: 'local', disabled: false },
          },
        },
      },
    };
    return host.update(next);
  };
  await configure('local');
  assert.equal(host.metadata().find(({ id }) => id === 'consumer')?.state, 'ready');
  const committed = settings;
  await assert.rejects(configure('global'), /Wrong scoped greeting/);
  assert.strictEqual(settings, committed);
  assert.equal(host.metadata().find(({ id }) => id === 'consumer')?.state, 'ready');
});

test('setup and live configuration cannot await their own graph transaction', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-reentrant-'));
  let settings = structuredClone(DEFAULTS);
  const builtins: FixtureModule[] = [
    {
      id: 'reentrant',
      title: 'Reentrant',
      description: '',
      plugin: {
        async apply(ctx: Context, config: Record<string, unknown>) {
          if (config.prepare) await ctx.harnessProfileScopes.prepare('session:session');
          ctx.on('internal/update', async (next) => {
            if (next.prepare) await ctx.harnessProfileScopes.prepare('session:session');
          });
        },
      },
    },
  ];
  const ctx = new Context();
  const host = new PluginHost(
    ctx,
    directory,
    fixtureProfile(
      directory,
      builtins,
      () => settings,
      (next) => {
        settings = next;
      },
    ),
  );
  ctx.provide('harnessProfileScopes', host);
  const sessionKey = createScopeKey();
  host.register('session', () => ({ key: sessionKey }));
  t.after(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await host.start();
  const configure = (prepare: boolean) => {
    const next = {
      ...settings,
      entries: { reentrant: { name: 'reentrant', disabled: false, live: true, config: { prepare } } },
    };
    return host.update(next);
  };
  await assert.rejects(configure(true), /cannot wait for its own Profile update/);
  await configure(false);
  const committed = settings;
  await assert.rejects(configure(true), /cannot wait for its own Profile update/);
  assert.strictEqual(settings, committed);
  await host.prepare('session:session');
});

test('a failed server entry does not publish its browser module', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-required-browser-'));
  const browser = 'web.js';
  const builtins: FixtureModule[] = [
    {
      id: 'ui',
      title: 'UI',
      description: '',
      browser,
    },
    {
      id: 'replacement',
      title: 'Replacement',
      description: '',
      browser,
      plugin: {
        apply(_ctx: Context, config: Record<string, unknown>) {
          if (config.fail) throw new Error('Unavailable replacement');
        },
      },
    },
  ];
  const settings = {
    ...structuredClone(DEFAULTS),
    entries: {
      ui: { name: 'ui', client: true },
      replacement: { name: 'replacement', client: true, disabled: false, config: { fail: true } },
    },
  };
  const host = new PluginHost(
    new Context(),
    directory,
    fixtureProfile(directory, builtins, () => settings),
  );
  t.after(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await host.start();
  assert.deepEqual(
    host.browser().map(({ id }) => id),
    ['ui'],
  );
  assert.equal(host.metadata().find(({ id }) => id === 'replacement')?.state, 'failed');
});

test('custom scope namespaces support normal Cordis composition and inheritance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-custom-scopes-'));
  const ctx = new Context();
  const settings = mergeSettings(structuredClone(DEFAULTS), {
    entries: { global: { name: 'global' } },
    scopes: {
      'project:alpha': {
        isolate: ['greeting'],
        entries: { local: { name: 'local' } },
      },
    },
  });
  const host = new PluginHost(
    ctx,
    directory,
    fixtureProfile(
      directory,
      [
        {
          id: 'global',
          title: 'Global',
          description: '',
          plugin: {
            provide: ['greeting'],
            apply(ctx) {
              ctx.provide('greeting', 'global');
            },
          },
        },
        {
          id: 'local',
          title: 'Local',
          description: '',
          plugin: {
            provide: ['greeting'],
            apply(ctx) {
              ctx.provide('greeting', 'project');
            },
          },
        },
      ],
      () => settings,
    ),
  );
  const projectKeys = fixtureKeys();
  const taskKey = createScopeKey(projectKeys('alpha'));
  host.register('project', (id) => ({ key: projectKeys(id) }), true);
  host.register('task', () => ({ key: taskKey, parent: 'project:alpha' }));
  t.after(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await host.start();
  await host.prepare('task:child');
  assert.equal(host.context('task:child').get('greeting'), 'project');
  assert.equal(host.context('project:beta').get('greeting'), 'global');
  assert.equal(scopeOf(host.context('project:alpha')), projectKeys('alpha'));
  assert.deepEqual(scopeChainOf(taskKey), [taskKey, projectKeys('alpha')]);
});

test('shipped, local and npm entries share metadata, configuration and resource lifecycle', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-plugin-parity-'));
  const folder = join(directory, 'node_modules', 'parity-plugin');
  const entry = join(folder, 'server', 'entry.mjs');
  const web = join(folder, 'web');
  mkdirSync(join(folder, 'server'), { recursive: true });
  mkdirSync(web, { recursive: true });
  writeJson(join(folder, 'package.json'), {
    name: 'parity-plugin',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './server/entry.mjs', './client': './web/main.js' },
  });
  const schema = {
    type: 'object',
    properties: { label: { type: 'string', default: 'Default' } },
    additionalProperties: false,
  };
  const browser = {
    browser: 'web/main.js',
    browserDirectory: 'web',
    browserStyles: ['web/b.css', 'web/a.css'],
  };
  writeJson(join(folder, 'plugin.json'), {
    title: 'Static title',
    description: 'Static description',
    configSchema: schema,
    ...browser,
  });
  const trace = join(directory, 'effects.log');
  const configKey = entry + '#config';
  Object.defineProperty(globalThis, configKey, { value: defineConfig(schema), configurable: true });
  writeFileSync(
    entry,
    `
    import { appendFileSync } from 'node:fs';
    const trace = ${JSON.stringify(trace)};
    appendFileSync(trace, 'import\\n');
    export const Config = globalThis[${JSON.stringify(configKey)}];
    export const metadata = ${JSON.stringify({ title: 'Native title', description: 'Native description', ...browser })};
    export function apply(ctx, config) {
      ctx.effect(() => {
        appendFileSync(trace, 'open:' + config.label + '\\n');
        return () => appendFileSync(trace, 'close:' + config.label + '\\n');
      });
    }
  `,
  );
  writeFileSync(join(web, 'main.js'), 'export function apply() {}');
  writeFileSync(join(web, 'a.css'), '.a {}');
  writeFileSync(join(web, 'b.css'), '.b {}');
  writeFileSync(join(folder, 'private.js'), 'private');
  let settings = mergeSettings(structuredClone(DEFAULTS), {
    entries: {
      bundled: { name: 'shipped-parity', disabled: true },
      local: { name: entry, disabled: true },
      npm: { name: 'parity-plugin', disabled: true },
    },
  });
  const host = new PluginHost(new Context(), join(directory, 'plugins'), {
    locate: (name) => (name === 'shipped-parity' ? { folder, entry } : undefined),
    source: () => join(directory, 'package.json'),
    read: () => settings,
    commit: (next) => {
      settings = next;
    },
  });
  t.after(async () => {
    await host.close();
    Reflect.deleteProperty(globalThis, configKey);
    rmSync(directory, { recursive: true, force: true });
  });
  await host.start();
  assert.equal(existsSync(trace), false);
  assert.equal(host.metadata().length, 3);
  assert.ok(host.metadata().every((item) => item.title === 'Static title' && item.state === 'disabled'));
  assert.deepEqual(host.browser(), []);
  await host.update({
    entries: { bundled: { disabled: false }, local: { disabled: false }, npm: { disabled: false } },
  });
  assert.ok(host.metadata().every((item) => item.title === 'Native title' && item.state === 'ready'));
  assert.equal(
    readFileSync(trace, 'utf8')
      .split('\n')
      .filter((line) => line === 'import').length,
    1,
  );
  const browserEntries = () => host.browser().sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(browserEntries().length, 3);
  for (const item of browserEntries()) {
    const asset = expectPresent(host.browserAsset(item.browser), 'entry asset');
    assert.equal(readFileSync(asset.path, 'utf8'), 'export function apply() {}');
    assert.deepEqual(
      item.styles?.map((path) => path.split('/').at(-1)),
      ['b.css', 'a.css'],
    );
    assert.equal(host.browserAsset(item.browser.replace(/web\/main\.js$/, 'private.js')), undefined);
  }
  await assert.rejects(host.update({ entries: { local: { config: { label: 42 } } } }));
  await host.update({
    entries: {
      bundled: { config: { label: 'B' } },
      local: { config: { label: 'L' } },
      npm: { config: { label: 'N' } },
    },
  });
  const before = browserEntries();
  writeFileSync(join(web, 'b.css'), '.b { color: red; }');
  await host.update({});
  const after = browserEntries();
  assert.equal(after.length, before.length);
  for (const [index, item] of after.entries()) {
    assert.notEqual(item.browser, before[index].browser);
    assert.equal(host.browserAsset(before[index].browser), undefined);
    const css = expectPresent(
      host.browserAsset(expectPresent(item.styles?.[0], 'stylesheet')),
      'stylesheet asset',
    );
    assert.equal(readFileSync(css.path, 'utf8'), '.b { color: red; }');
  }
  await host.update({
    entries: { bundled: { disabled: true }, local: { disabled: true }, npm: { disabled: true } },
  });
  assert.deepEqual(host.browser(), []);
  const events = readFileSync(trace, 'utf8').split('\n');
  assert.equal(
    events.filter((line) => line.startsWith('open:')).length,
    events.filter((line) => line.startsWith('close:')).length,
  );
});
