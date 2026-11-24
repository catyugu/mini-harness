import { tmpdir } from 'node:os';
import { fixture, waitUntil } from '../support/api-fixture.js';
import { pluginSdkUrl, writePlugin } from '../support/plugin-fixture.js';
import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '@mini-harness/host/application';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { DEFAULTS, mergeSettings, readSettings } from '@mini-harness/settings/config';
import { writeJson } from '@mini-harness/platform/json';

import { Context } from 'cordis';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { PluginHost } from '@mini-harness/plugins/manager';

declare module '@mini-harness/kernel/services' {
  interface ServiceMap {
    greeting: string;
    extra: string;
  }
}

test('an installed Cordis plugin can use services, configure a tool, and release resources', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });

  const folder = join(paths.plugins, 'example');
  const log = join(folder, 'effects.log');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ inject: ['harnessTools', 'harnessSessions'], configSchema: {
    type: 'object', properties: { prefix: { type: 'string', default: 'Count' } }
  }, title: 'Example plugin', icon: {
    path: 'M2 2h20v20H2z', viewBox: '0 0 24 24'
  } }));
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${pluginSdkUrl}";

    import { appendFileSync } from 'node:fs';
    export default (ctx, api) => {
      const { config } = api;
      api.onDispose(() => appendFileSync(${JSON.stringify(log)}, 'dispose\\n'));
      api.contribute(toolExtensions.register, {
        name: 'example_count', label: 'Count', description: 'Count sessions',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: config.prefix + ': ' + ctx.harnessSessions.list().length }] };
        }
      });
    };
  `);
  await runtime.start();
  const item = runtime.registry.create();
  assert.equal(runtime.plugins.metadata().find(({ id }) => id === 'example')?.title, 'Example plugin');
  assert.deepEqual(runtime.plugins.metadata().find(({ id }) => id === 'example')?.icon,
    { path: 'M2 2h20v20H2z', viewBox: '0 0 24 24' });
  await runtime.configuration.update({ plugins: { example: true }, pluginConfig: { example: { prefix: 'Total' } } });
  await runtime.plugins.ctx.harnessAgent.prepare(item.id);
  const activeNames = () => runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name);
  assert.ok(activeNames().includes('example_count'));
  const tool = expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'example_count'), 'example count tool');
  assert.equal((await tool.execute('test', {}, undefined, undefined, undefined)).content[0].type, 'text');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /Total: 1/);
  await assert.rejects(runtime.configuration.update({ pluginConfig: { example: { prefix: 12 } } }), /Invalid configuration/);
  assert.equal(runtime.settings.pluginConfig.example.prefix, 'Total');
  await runtime.plugins.ctx.harnessAgent.prepare(item.id);
  assert.match(JSON.stringify(await tool.execute('after-invalid-config', {}, undefined, undefined, undefined)), /Total: 1/);
  assert.equal(activeNames().filter((name) => name === 'example_count').length, 1);
  await runtime.configuration.update({ plugins: { shell: true } });
  assert.throws(() => readFileSync(log), { code: 'ENOENT' }, 'Unrelated switches and invalid config preserve an active plugin');
  await runtime.configuration.update({ plugins: { example: false } });
  assert.equal(readFileSync(log, 'utf8'), 'dispose\n');
  assert.ok(!activeNames().includes('example_count'));
  await assert.rejects(tool.execute('after-unload', {}, undefined, undefined, undefined), /no longer available/);
  await runtime.configuration.update({ plugins: { example: true } });
  assert.ok(activeNames().includes('example_count'));
});

test('file tools have a plugin lifecycle and required plugins cannot be disabled independently', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'dependent');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ inject: ['harnessTools'], requires: ['files'] }));
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${pluginSdkUrl}";
export default (ctx, api) => {
    api.contribute(toolExtensions.register, { name: 'dependent_tool', description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  };`);
  await runtime.start();
  const item = runtime.registry.create();
  await runtime.plugins.ctx.harnessAgent.prepare(item.id);
  const activeNames = () => runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name);
  assert.ok(activeNames().includes('read'));
  await runtime.configuration.update({ plugins: { files: false } });
  assert.ok(!activeNames().includes('read'));
  await runtime.configuration.update({ plugins: { files: true, dependent: true } });
  await assert.rejects(runtime.configuration.update({ plugins: { files: false } }), /Required plugin/);
  assert.equal(runtime.settings.plugins.files, true);
  assert.ok(activeNames().includes('dependent_tool'));
  await runtime.configuration.update({ plugins: { files: false, dependent: false } });
  assert.equal(runtime.plugins.ctx.harnessTools.forSession(item.id).some(({ name }) => name === 'read' || name === 'dependent_tool'), false);
});

test('server entry requires a default setup function', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [id, source] of [
    ['function-entry', `export default function(ctx) {
      if (ctx.harnessSessions.list().length !== 0) throw new Error('Unexpected sessions');
    }`],
    ['named-entry', 'export default { apply() {} }']
  ]) {
    mkdirSync(join(paths.plugins, id));
    writeFileSync(join(paths.plugins, id, 'plugin.js'), source);
    writeFileSync(join(paths.plugins, id, 'plugin.json'), JSON.stringify({ inject: ['harnessSessions'] }));
  }
  await runtime.start();
  await runtime.configuration.update({ plugins: { 'function-entry': true } });
  await assert.rejects(runtime.configuration.update({ plugins: { 'named-entry': true } }), /Export a default setup function/);
  assert.equal(runtime.settings.plugins['function-entry'], true);
  assert.equal(runtime.settings.plugins['named-entry'], undefined);
  assert.equal(readSettings(paths).plugins['named-entry'], undefined);
});

test('plugin JSON Schema applies defaults and rejects invalid changes before setup', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'schema');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ inject: ['harnessTools'], configChanges: 'live', configSchema: {
    type: 'object', additionalProperties: false, required: ['count'],
    properties: { count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      options: { type: 'object', default: {}, properties: { enabled: { type: 'boolean', default: true } } } }
  } }));
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${pluginSdkUrl}";
export default (ctx, api) => {
    const changes = [];
    api.configuration.subscribe('count', (value) => changes.push(value));
    api.contribute(toolExtensions.register, { name: 'schema_value', description: 'Fixture', parameters: { type: 'object', properties: {} },
      async execute(_id, changesToSave) {
        if (Object.keys(changesToSave).length) await api.configuration.patch(changesToSave);
        return { content: [{ type: 'text', text: api.configuration.get('count') + ':' +
          api.configuration.get('options').enabled + ':' + changes.join(',') }] };
      }
    });
  };`);
  await runtime.start();
  await runtime.configuration.update({ plugins: { schema: true } });
  const item = runtime.registry.create();
  const tool = expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'schema_value'), 'schema tool');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /3:true/);
  await Promise.all([
    tool.execute('set-count', { count: 7 }, undefined, undefined, undefined),
    tool.execute('set-options', { options: { enabled: false } }, undefined, undefined, undefined),
  ]);
  assert.deepEqual(readSettings(paths).pluginConfig.schema, { count: 7, options: { enabled: false } });
  await assert.rejects(tool.execute('invalid-count', { count: 0 }, undefined, undefined, undefined), /Invalid configuration/);
  assert.match(JSON.stringify(await tool.execute('committed', {}, undefined, undefined, undefined)), /7:false:7/);
  await assert.rejects(runtime.configuration.update({ pluginConfig: { schema: { count: 0 } } }), /Invalid configuration/);
  assert.deepEqual(await tool.execute('test', {}, undefined, undefined, undefined),
    await expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'schema_value'), 'registered schema tool')
      .execute('test', {}, undefined, undefined, undefined));
});

test('dependent plugins restart in order and partial setup or persistence failures restore their resources', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const log = join(paths.plugins, 'lifecycle.log');
  for (const id of ['base', 'dependent']) {
    const folder = join(paths.plugins, id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ inject: ['harnessTools'], requires: id === 'dependent' ? ['base'] : [] }));
    writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${pluginSdkUrl}";

      import { appendFileSync } from 'node:fs';
      export default (ctx, api) => {
        appendFileSync(${JSON.stringify(log)}, 'start ${id}\\n');
        api.onDispose(() => appendFileSync(${JSON.stringify(log)}, 'stop ${id}\\n'));
        api.contribute(toolExtensions.register, { name: '${id}_tool', description: 'Fixture', parameters: {type: 'object', properties: {}},
          execute: async () => ({content: [{type: 'text', text: String(api.config.value ?? 'original')}]}) });
        if (api.config.fail) throw new Error('Partial setup failed');
      };`);
  }
  await runtime.start();
  await runtime.configuration.update({ plugins: { base: true, dependent: true } });
  await assert.rejects(runtime.configuration.update({ pluginConfig: { base: { fail: true } } }), /Partial setup failed/);
  assert.match(readFileSync(log, 'utf8'), /stop dependent\nstop base\nstart base\nstop base\nstart base\nstart dependent/);
  const item = runtime.registry.create();
  assert.equal(runtime.plugins.ctx.harnessTools.forSession(item.id).filter(({ name }) => name === 'base_tool').length, 1);
  const next = mergeSettings(runtime.settings, { pluginConfig: { base: { value: 'replacement' } } });
  await assert.rejects(runtime.plugins.configure(next, () => { throw new Error('Persistence failed'); }), /Persistence failed/);
  const restored = expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'base_tool'), 'restored tool');
  assert.match(JSON.stringify(await restored.execute('test', {}, undefined, undefined, undefined)), /original/);
  assert.ok(runtime.plugins.ctx.harnessTools.forSession(item.id).some(({ name }) => name === 'dependent_tool'));
});

test('cyclic dependencies reject a configuration before mounting either plugin', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [id, dependency] of [['first', 'second'], ['second', 'first']]) {
    const folder = join(paths.plugins, id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ requires: [dependency] }));
    writeFileSync(join(folder, 'plugin.js'), 'export default () => { throw new Error("Should not mount"); };');
  }
  await runtime.start();
  await assert.rejects(runtime.configuration.update({ plugins: { first: true, second: true } }), /Cyclic plugin/);
  assert.equal(runtime.settings.plugins.first, undefined);
});

test('malformed plugin manifests fail discovery instead of silently dropping their metadata', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'broken-manifest');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default () => {};');
  writeFileSync(join(folder, 'plugin.json'), '{"requires": [');
  assert.match(runtime.plugins.metadata().find(({ id }) => id === 'broken-manifest')?.error ?? '', /JSON|Unexpected|parse/i);
  await runtime.start();
  await assert.rejects(runtime.configuration.update({ plugins: { 'broken-manifest': true } }), /Invalid plugin/);
  assert.equal(runtime.settings.plugins['broken-manifest'], undefined);
});

test('disabled optional builtins cannot block boot or reload because their config is malformed', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const settings = readSettings(paths);
  writeJson(paths.settings, { ...settings, plugins: { subagents: false },
    pluginConfig: { ...settings.pluginConfig, subagents: { maxDepth: 100 } } });
  const restored = new MiniHarnessRuntime(paths);
  t.after(() => restored.stop());
  await restored.start();
  assert.match(restored.plugins.metadata().find(({ id }) => id === 'subagents')?.error ?? '', /Invalid configuration/);
  await assert.rejects(restored.configuration.update({ pluginConfig: { subagents: { maxDepth: 101 } } }), /Invalid configuration/);
  await assert.rejects(restored.configuration.update({ pluginConfig: { subagents: { model: { provider: 'unknown', id: 'missing' } } } }), /Unknown child model/);
  await restored.configuration.update({ pluginConfig: { 'core:theme': { appearance: 'dark' } } });
  const conversation = restored.registry.create();
  assert.equal(await restored.plugins.ctx.harnessRuns.send(conversation.id, 'Main agent still works'), 'Mock response');
  await restored.configuration.update({ plugins: { subagents: true }, pluginConfig: { subagents: { maxDepth: 2 } } });
  assert.ok(restored.plugins.ctx.harnessTools.forSession(conversation.id).some(({ name }) => name === 'delegate'));
});

test('an optional plugin that fails at startup reports its state without blocking other capabilities', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'fails-to-start');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), "export default () => { throw new Error('Startup failed'); };");
  writeFileSync(join(folder, 'web.js'), 'export default () => {};');
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
  writeJson(paths.settings, { ...readSettings(paths), plugins: { 'fails-to-start': true } });
  const restarted = new MiniHarnessRuntime(paths);
  t.after(async () => { await restarted.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await restarted.start();
  const status = expectPresent(restarted.plugins.metadata().find(({ id }) => id === 'fails-to-start'), 'failed plugin');
  assert.equal(status.state, 'failed');
  assert.match(expectPresent(status.error, 'startup error'), /Startup failed/);
  assert.ok(!restarted.plugins.browser().some(({ id }) => id === status.id));
  await restarted.configuration.update({ pluginConfig: { 'core:theme': { appearance: 'dark' } } });
  assert.equal(restarted.settings.pluginConfig['core:theme'].appearance, 'dark');
  await restarted.configuration.update({ plugins: { 'fails-to-start': false } });
  assert.equal(expectPresent(restarted.plugins.metadata().find(({ id }) => id === status.id), 'disabled plugin metadata').state, 'disabled');
});

test('unloading a route signals an active request and waits for its cleanup', async (t) => {
  const { paths, root, request } = await fixture(t);
  const entered = join(root, 'entered');
  const drained = join(root, 'drained');
  writePlugin(paths.plugins, 'drain', { inject: ['harnessRoutes'] }, `
    import { writeFileSync } from 'node:fs';
    export default (_ctx, api) => api.registerRoute('GET', '/wait', async ({ signal }) => {
      writeFileSync(${JSON.stringify(entered)}, 'ready');
      await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      await new Promise((done) => setImmediate(done));
      writeFileSync(${JSON.stringify(drained)}, 'done');
    });`);
  const toggle = (active: boolean) => request('/settings', 'PATCH', { plugins: { drain: active } });
  assert.equal((await toggle(true)).status, 200);
  const current = request('/extensions/drain/wait');
  await waitUntil(() => existsSync(entered), Boolean);
  assert.equal((await toggle(false)).status, 200);
  assert.equal(readFileSync(drained, 'utf8'), 'done');
  assert.equal((await current).status, 400);
  assert.equal((await request('/extensions/drain/wait')).status, 404);
});

test('live scoped providers isolate siblings, restore inheritance and roll back failed setup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-live-scopes-'));
  const workspaceId = 'a'.repeat(32), otherWorkspace = 'b'.repeat(32);
  const records = new Map<string, SessionRecord>([
    ['parent', { id: 'parent', workspaceId, parentId: null } as SessionRecord],
    ['child', { id: 'child', workspaceId, parentId: 'parent' } as SessionRecord],
    ['sibling', { id: 'sibling', workspaceId, parentId: null } as SessionRecord],
    ['independent', { id: 'independent', workspaceId: otherWorkspace, parentId: null } as SessionRecord]
  ]);
  const released: string[] = [];
  const builtins: PluginDescriptor[] = [
    { id: 'global', scope: 'application', title: 'Global', description: '', required: true,
      provides: ['greeting', 'extra'], setup(_ctx, api) { api.provide('greeting', 'global'); api.provide('extra', 'retained'); } },
    { id: 'workspace', scope: 'workspace', title: 'Workspace', description: '', provides: ['greeting'],
      configSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      setup(_ctx, api) { api.provide('greeting', String(api.config.value)); } },
    { id: 'layer', scope: 'session', title: 'Layer', description: '', provides: ['greeting'],
      setup(_ctx, api) {
        api.onDispose(() => { released.push(String(api.config.value)); });
        if (api.config.fail) throw new Error('Scoped setup failed');
        api.provide('greeting', String(api.config.value));
      } }
  ];
  const workspaceKey = 'workspace:' + workspaceId;
  const workspace = { plugins: { workspace: true }, providers: { greeting: 'workspace' }, pluginConfig: { workspace: { value: 'workspace' } } };
  let settings: typeof DEFAULTS = { ...structuredClone(DEFAULTS), scopes: {
    [workspaceKey]: { ...workspace, pluginConfig: { workspace: { value: 42 } } }
  } };
  const ctx = new Context();
  ctx.provide('authority', {});
  const host = new PluginHost(ctx, directory, builtins, ['authority'], () => settings,
    (id) => records.get(id));
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await host.start(settings);
  assert.equal(host.metadata().find(({ id }) => id === 'workspace')?.state, 'failed');
  assert.throws(() => host.require('sibling', 'greeting'), /Invalid configuration/);
  assert.equal(host.require('independent', 'greeting'), 'global');
  const configure = (scopes: typeof settings.scopes) => {
    const next = { ...settings, scopes };
    return host.configure(next, () => { settings = next; });
  };
  const parent = { plugins: { layer: true }, providers: { greeting: 'layer' }, pluginConfig: { layer: { value: 'parent' } } };
  const child = { plugins: { layer: true }, providers: { greeting: 'layer' }, pluginConfig: { layer: { value: 'child' } } };
  const broken = { ...parent, pluginConfig: { layer: { fail: true } } };
  await configure({ [workspaceKey]: workspace, 'session:parent': parent, 'session:child': child, 'session:sibling': broken });
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'inactive');
  await host.prepare('child');
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'partial', 'unprepared peer scopes remain visible');
  assert.equal(host.require('parent', 'greeting'), 'parent');
  assert.equal(host.require('child', 'greeting'), 'child');
  await host.prepare('sibling');
  assert.throws(() => host.require('sibling', 'greeting'), /Scoped setup failed/);
  assert.equal(host.require('independent', 'greeting'), 'global');
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'partial');
  await configure({ ...settings.scopes, 'session:sibling': { ...parent, pluginConfig: { layer: { value: 'fixed' } } } });
  assert.equal(host.require('sibling', 'greeting'), 'fixed');
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'ready');
  assert.equal(host.require('child', 'extra'), 'retained');
  await assert.rejects(configure({ ...settings.scopes, 'session:parent': {
    ...parent, pluginConfig: { layer: { value: 'broken', fail: true } }
  } }), /Scoped setup failed/);
  assert.equal(host.require('child', 'greeting'), 'child');
  assert.equal(host.require('parent', 'greeting'), 'parent');
  assert.ok(released.includes('broken'));

  // Keep the scope alive for policy but remove its service; a stale isolate must not mask the parent.
  await configure({ 'session:parent': parent, 'session:child': { disabledTools: ['shell'] } });
  assert.equal(host.require('child', 'greeting'), 'parent');

  // Adding a configured ancestor of an already mounted child must mount that ancestor immediately.
  await configure({ [workspaceKey]: workspace,
    'session:child': { disabledTools: ['shell'] } });
  assert.equal(host.require('child', 'greeting'), 'workspace');
  assert.equal(host.require('sibling', 'greeting'), 'workspace');
  assert.equal(ctx.get('greeting'), 'global');
  await configure({});
  assert.equal(host.require('child', 'greeting'), 'global');
});

test('configuration validation resolves the staged scope provider and rejects invalid writes atomically', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-validate-scope-'));
  const workspaceId = 'a'.repeat(32);
  const key = 'workspace:' + workspaceId;
  let settings = structuredClone(DEFAULTS);
  const builtins: PluginDescriptor[] = [
    { id: 'global', scope: 'application', title: 'Default', description: '', required: true, provides: ['greeting'],
      setup(_ctx, api) { api.provide('greeting', 'global'); } },
    { id: 'local', scope: 'workspace', title: 'Local', description: '', provides: ['greeting'],
      setup(_ctx, api) { api.provide('greeting', 'local'); } },
    { id: 'consumer', scope: 'workspace', title: 'Consumer', description: '', inject: ['greeting'],
      configSchema: { type: 'object', properties: { expected: { type: 'string' } }, required: ['expected'] },
      validateConfig(config, { operation, service }) {
        if (config.expected !== service('greeting')) throw new Error('Wrong scoped greeting during ' + operation);
      } }
  ];
  const host = new PluginHost(new Context(), directory, builtins, [], () => settings, () => undefined);
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await host.start(settings);
  const configure = (expected: string) => {
    const next = { ...settings, scopes: { [key]: {
      plugins: { consumer: true, local: true },
      providers: { greeting: 'local' },
      pluginConfig: { consumer: { expected } }
    } } };
    return host.configure(next, () => { settings = next; });
  };
  await configure('local');
  assert.equal(host.metadata().find(({ id }) => id === 'consumer')?.state, 'ready');
  const committed = settings;
  await assert.rejects(configure('global'), /Wrong scoped greeting/);
  assert.strictEqual(settings, committed);
  assert.equal(host.metadata().find(({ id }) => id === 'consumer')?.state, 'ready');
});
