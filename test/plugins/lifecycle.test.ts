import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { fixture, waitUntil } from '../support/api-fixture.js';
import { writePlugin } from '../support/plugin-fixture.js';
import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '@mini-harness/host/application';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { DEFAULTS, mergeSettings, readSettings } from '@mini-harness/settings/config';
import { writeJson } from '@mini-harness/platform/json';

import { Context } from 'mini-harness/cordis';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { PluginHost } from '@mini-harness/plugins/manager';

declare module 'mini-harness/cordis' {
  interface Context {
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
  writeFileSync(join(folder, 'plugin.js'), `
export const inject = ["harnessSessions","harnessTools"];

import { appendFileSync } from 'node:fs';
import { Context } from 'mini-harness/cordis';
export const apply = (ctx, config) => {
      if (!(ctx instanceof Context)) throw new Error('Plugin loaded a different Cordis runtime');
      const sessions = ctx.harnessSessions.access();
      ctx.effect(() => () => appendFileSync(${JSON.stringify(log)}, 'dispose\\n'));
      ctx.effect(() => ctx.harnessTools.register({
        name: 'example_count', label: 'Count', description: 'Count sessions',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: config.prefix + ': ' + sessions.list().length }] };
        }
      }));
    };
`);
  await runtime.start();
  const item = runtime.plugins.ctx.harnessRegistry.create();
  assert.equal(runtime.plugins.metadata().find(({ id }) => id === 'example')?.title, 'Example plugin');
  assert.deepEqual(runtime.plugins.metadata().find(({ id }) => id === 'example')?.icon,
    { path: 'M2 2h20v20H2z', viewBox: '0 0 24 24' });
  await runtime.configuration.update({ plugins: { example: true }, pluginConfig: { example: { prefix: 'Total' } } });
  await runtime.plugins.prepare(`session:${item.id}`);
  const activeNames = () => runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name);
  assert.ok(activeNames().includes('example_count'));
  const tool = expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'example_count'), 'example count tool');
  assert.equal((await tool.execute('test', {}, undefined, undefined, undefined)).content[0].type, 'text');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /Total: 1/);
  await assert.rejects(runtime.configuration.update({ pluginConfig: { example: { prefix: 12 } } }), /Invalid configuration/);
  assert.equal(runtime.settings.pluginConfig.example.prefix, 'Total');
  await runtime.plugins.prepare(`session:${item.id}`);
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
  writeFileSync(join(folder, 'plugin.js'), `
export const inject = ["harnessTools"];

export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessTools.register({ name: 'dependent_tool', description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
  };
`);
  await runtime.start();
  const item = runtime.plugins.ctx.harnessRegistry.create();
  await runtime.plugins.prepare(`session:${item.id}`);
  const activeNames = () => runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name);
  assert.ok(activeNames().includes('read'));
  await runtime.configuration.update({ plugins: { files: false } });
  assert.ok(!activeNames().includes('read'));
  await runtime.configuration.update({ plugins: { files: true, dependent: true } });
  await assert.rejects(runtime.configuration.update({ plugins: { files: false } }), /No enabled provider/);
  assert.equal(runtime.settings.plugins.files, true);
  assert.ok(activeNames().includes('dependent_tool'));
  await runtime.configuration.update({ plugins: { files: false, dependent: false } });
  assert.equal(runtime.plugins.ctx.harnessTools.forSession(item.id).some(({ name }) => name === 'read' || name === 'dependent_tool'), false);
});

test('server entries support named Cordis declarations and reject an invalid module', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [id, source] of [
    ['function-entry', `
export const inject = ["harnessSessions"];

export function apply(ctx) {
      if (ctx.harnessSessions.access().list().length !== 0) throw new Error('Unexpected sessions');
    }
`],
    ['named-entry', 'export const setup = () => {}']
  ]) {
    mkdirSync(join(paths.plugins, id));
    writeFileSync(join(paths.plugins, id, 'plugin.js'), source);
    writeFileSync(join(paths.plugins, id, 'plugin.json'), JSON.stringify({ inject: ['harnessSessions'] }));
  }
  await runtime.start();
  await runtime.configuration.update({ plugins: { 'function-entry': true } });
  await assert.rejects(runtime.configuration.update({ plugins: { 'named-entry': true } }), /must export a Cordis plugin/);
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
  writeFileSync(join(folder, 'plugin.js'), `
export const inject = ["harnessPluginSettings","harnessTools"];

export function validateConfig(config) {
  if (config.count === 5) throw new Error('Five is reserved');
}
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
`);
  await runtime.start();
  await runtime.configuration.update({ plugins: { schema: true } });
  const item = runtime.plugins.ctx.harnessRegistry.create();
  const tool = expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'schema_value'), 'schema tool');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /3:true/);
  await Promise.all([
    tool.execute('set-count', { count: 7 }, undefined, undefined, undefined),
    tool.execute('set-options', { options: { enabled: false } }, undefined, undefined, undefined),
  ]);
  assert.deepEqual(readSettings(paths).pluginConfig.schema, { count: 7, options: { enabled: false } });
  await assert.rejects(tool.execute('rejected-semantics', { count: 5 }), /Five is reserved/);
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
    writeFileSync(join(folder, 'plugin.js'), `
export const inject = ["harnessTools"];

import { appendFileSync } from 'node:fs';
export const apply = (ctx, config) => {
        appendFileSync(${JSON.stringify(log)}, 'start ${id}\\n');
        ctx.effect(() => () => appendFileSync(${JSON.stringify(log)}, 'stop ${id}\\n'));
        ctx.effect(() => ctx.harnessTools.register({ name: '${id}_tool', description: 'Fixture', parameters: {type: 'object', properties: {}},
          execute: async () => ({content: [{type: 'text', text: String(config.value ?? 'original')}]}) }));
        if (config.fail) throw new Error('Partial setup failed');
      };
`);
  }
  await runtime.start();
  await runtime.configuration.update({ plugins: { base: true, dependent: true } });
  await assert.rejects(runtime.configuration.update({ pluginConfig: { base: { fail: true } } }), /Partial setup failed/);
  assert.match(readFileSync(log, 'utf8'), /stop dependent\nstop base\nstart base\nstop base\nstart base\nstart dependent/);
  const item = runtime.plugins.ctx.harnessRegistry.create();
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
    writeFileSync(join(folder, 'plugin.js'), "export default () => { throw new Error(\"Should not mount\"); };");
  }
  await runtime.start();
  await assert.rejects(runtime.configuration.update({ plugins: { first: true, second: true } }), /No enabled provider/);
  assert.equal(runtime.settings.plugins.first, undefined);
});

test('malformed plugin manifests fail discovery instead of silently dropping their metadata', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'broken-manifest');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), "export default () => {};");
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
  const conversation = restored.plugins.ctx.harnessRegistry.create();
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
  writeFileSync(join(folder, 'web.js'), "export default () => {};");
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

test('unloading cancels and drains HTTP, scoped requests and upgrades before disposing resources', async (t) => {
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
  writePlugin(paths.plugins, 'drain', { inject: ['harnessSettingsStore'] }, lifecycle + `
export const inject = ["harnessPluginRoutes","harnessSettingsStore"];
export const apply = (ctx) => {
      ctx.effect(() => () => mark('app:disposed'));
      ctx.harnessPluginRoutes.register('GET', '/wait', ({ signal }) => wait('http', signal));
      ctx.harnessPluginRoutes.register('POST', '/body', async ({ body }) => {
        mark('body:entered');
        try { return await body(); }
        finally { mark('body:drained'); }
      });
      ctx.harnessPluginRoutes.register('POST', '/disable', async () => {
        try { await ctx.harnessSettingsStore.update({ plugins: { drain: false } }); }
        catch (error) { return { error: error.message }; }
      });
      ctx.harnessPluginRoutes.upgrade('/socket', async (_request, _socket, _head, signal) => wait('ws', signal));
    };
`);
  writePlugin(paths.plugins, 'scoped-drain', { scope: 'session' }, lifecycle + `
export const inject = ["harnessPluginRoutes"];
export const apply = (ctx) => {
      ctx.effect(() => () => mark('scope:disposed'));
      ctx.harnessPluginRoutes.scope('wait', (_input, signal) => wait('scope', signal));
    };
`);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  const scope = `session:${session.id}`;
  const toggle = (active: boolean) => request('/settings', 'PATCH', {
    plugins: { drain: active }, scopes: { [scope]: { plugins: { 'scoped-drain': active } } }
  });
  assert.equal((await toggle(true)).status, 200);
  const attempted = await request('/extensions/drain/disable', 'POST');
  assert.match(attempted.body.error, /Structural settings cannot be changed during a plugin request/);
  assert.equal(app.runtime.settings.plugins.drain, true);
  const current = request('/extensions/drain/wait');
  const currentScope = request('/plugins/scoped-drain/scopes/' + scope + '/wait', 'POST', {});
  const bodyStatus = new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(base + '/api/extensions/drain/body', {
      method: 'POST', headers: { ...headers, 'Content-Length': '20' }
    }, response => { response.resume(); resolve(response.statusCode); request.destroy(); });
    request.once('error', reject);
    request.write('{"partial":');
  });
  const closed = new Promise<void>((resolve, reject) => {
    const request = httpRequest(base + '/api/extensions/drain/socket', {
      headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket' }
    }, (response) => { response.resume(); reject(new Error('Unexpected upgrade response ' + response.statusCode)); });
    request.once('error', (error) => 'code' in error && error.code === 'ECONNRESET' ? resolve() : reject(error));
    request.end();
  });
  try {
    await waitUntil(() => existsSync(trace) ? readFileSync(trace, 'utf8') : '', (log) =>
      ['http:entered', 'ws:entered', 'scope:entered', 'body:entered'].every((entry) => log.includes(entry)));
  } finally { assert.equal((await toggle(false)).status, 200); }
  const log = readFileSync(trace, 'utf8').split('\n');
  for (const [name, disposal] of [['http', 'app'], ['ws', 'app'], ['scope', 'scope'], ['body', 'app']]) {
    const drained = log.indexOf(name + ':drained');
    assert.ok(drained > log.indexOf(name + ':entered') && drained < log.indexOf(disposal + ':disposed'), log.join(', '));
  }
  await closed;
  assert.equal((await current).status, 400);
  assert.equal(await bodyStatus, 400);
  assert.equal((await currentScope).status, 503);
  assert.equal((await request('/extensions/drain/wait')).status, 404);
  assert.equal((await request('/plugins/scoped-drain/scopes/' + scope + '/wait', 'POST', {})).status, 404);
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
    { id: 'global', scope: 'application', title: 'Global', description: '', defaultEnabled: true,
      plugin: { provide: ['greeting', 'extra'], apply(ctx) { ctx.provide('greeting', 'global'); ctx.provide('extra', 'retained'); } } },
    { id: 'workspace', scope: 'workspace', title: 'Workspace', description: '', provides: ['greeting'],
      configSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      plugin: { provide: 'greeting', apply(ctx: Context, config: Record<string, unknown>) { ctx.provide('greeting', String(config.value)); } } },
    { id: 'layer', scope: 'session', title: 'Layer', description: '', provides: ['greeting'],
      plugin: { provide: 'greeting', apply(ctx: Context, config: Record<string, unknown>) {
        ctx.effect(() => () => { released.push(String(config.value)); });
        if (config.fail) throw new Error('Scoped setup failed');
        ctx.provide('greeting', String(config.value));
      } } }
  ];
  const workspaceKey = 'workspace:' + workspaceId;
  const workspace = { plugins: { workspace: true }, providers: { greeting: 'workspace' }, pluginConfig: { workspace: { value: 'workspace' } } };
  let settings: typeof DEFAULTS = { ...structuredClone(DEFAULTS), scopes: {
    [workspaceKey]: { ...workspace, pluginConfig: { workspace: { value: 42 } } }
  } };
  const ctx = new Context();
  ctx.provide('authority', {});
  const host = new PluginHost(ctx, directory, builtins, ['authority'], () => settings, undefined, undefined, undefined,
    { requiredServices: new Set(['greeting', 'extra']) });
  host.register('workspace', (id) => ({ scope: { kind: 'workspace', workspaceId: id } }), true);
  host.register('session', (id) => {
    const record = records.get(id);
    return record && { scope: { kind: 'session', sessionId: id, workspaceId: record.workspaceId },
      parent: record.parentId ? `session:${record.parentId}` : `workspace:${record.workspaceId}` };
  });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await host.start(settings);
  assert.equal(host.metadata().find(({ id }) => id === 'workspace')?.state, 'failed');
  assert.throws(() => host.require('session:sibling', 'greeting'), /Invalid configuration/);
  assert.equal(host.require('session:independent', 'greeting'), 'global');
  const configure = (scopes: typeof settings.scopes) => {
    const next = { ...settings, scopes };
    return host.configure(next, () => { settings = next; });
  };
  const parent = { plugins: { layer: true }, providers: { greeting: 'layer' }, pluginConfig: { layer: { value: 'parent' } } };
  const child = { plugins: { layer: true }, providers: { greeting: 'layer' }, pluginConfig: { layer: { value: 'child' } } };
  const broken = { ...parent, pluginConfig: { layer: { fail: true } } };
  await assert.rejects(configure({ [workspaceKey]: workspace, 'session:parent': parent, 'session:child': child, 'session:sibling': broken }), /Scoped setup failed/);
  assert.ok(!Object.hasOwn(settings.scopes, 'session:sibling'));
  await configure({ [workspaceKey]: workspace, 'session:parent': parent, 'session:child': child });
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'ready', 'required replacements are mounted before commit');
  assert.equal(host.require('session:parent', 'greeting'), 'parent');
  assert.equal(host.require('session:child', 'greeting'), 'child');
  assert.equal(host.require('session:sibling', 'greeting'), 'workspace');
  assert.equal(host.require('session:independent', 'greeting'), 'global');
  await configure({ ...settings.scopes, 'session:sibling': { ...parent, pluginConfig: { layer: { value: 'fixed' } } } });
  assert.equal(host.require('session:sibling', 'greeting'), 'fixed');
  assert.equal(host.metadata().find(({ id }) => id === 'layer')?.state, 'ready');
  assert.equal(host.require('session:child', 'extra'), 'retained');
  await assert.rejects(configure({ ...settings.scopes, 'session:parent': {
    ...parent, pluginConfig: { layer: { value: 'broken', fail: true } }
  } }), /Scoped setup failed/);
  assert.equal(host.require('session:child', 'greeting'), 'child');
  assert.equal(host.require('session:parent', 'greeting'), 'parent');
  assert.ok(released.includes('broken'));

  // Keep the scope alive for policy but remove its service; a stale isolate must not mask the parent.
  await configure({ 'session:parent': parent, 'session:child': { disabledTools: ['shell'] } });
  assert.equal(host.require('session:child', 'greeting'), 'parent');

  // Adding a configured ancestor of an already mounted child must mount that ancestor immediately.
  await configure({ [workspaceKey]: workspace,
    'session:child': { disabledTools: ['shell'] } });
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
  let settings = structuredClone(DEFAULTS);
  const builtins: PluginDescriptor[] = [
    { id: 'global', scope: 'application', title: 'Default', description: '', defaultEnabled: true, provides: ['greeting'],
      plugin: { provide: 'greeting', apply(ctx) { ctx.provide('greeting', 'global'); } } },
    { id: 'local', scope: 'workspace', title: 'Local', description: '', provides: ['greeting'],
      plugin: { provide: 'greeting', apply(ctx) { ctx.provide('greeting', 'local'); } } },
    { id: 'consumer', scope: 'workspace', title: 'Consumer', description: '', plugin: { inject: ['greeting'], apply() {} },
      configSchema: { type: 'object', properties: { expected: { type: 'string' } }, required: ['expected'] },
      validateConfig(config, { operation, service }) {
        if (config.expected !== service('greeting')) throw new Error('Wrong scoped greeting during ' + operation);
      } }
  ];
  const host = new PluginHost(new Context(), directory, builtins, [], () => settings);
  host.register('workspace', (id) => ({ scope: { kind: 'workspace', workspaceId: id } }), true);
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


test('setup and live configuration cannot await their own graph transaction', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-reentrant-'));
  let settings = structuredClone(DEFAULTS);
  const builtins: PluginDescriptor[] = [{
    id: 'reentrant', scope: 'application', title: 'Reentrant', description: '', configChanges: 'live',
    plugin: { async apply(ctx: Context, config: Record<string, unknown>) {
      if (config.prepare) await ctx.harnessScopes.prepare('session:session');
      ctx.on('internal/update', async (next) => {
        if (next.prepare) await ctx.harnessScopes.prepare('session:session');
      });
    } }
  }];
  const ctx = new Context();
  const host = new PluginHost(ctx, directory, builtins, [], () => settings);
  ctx.provide('harnessScopes', host);
  host.register('session', (id) => ({ scope: { kind: 'session', sessionId: id, workspaceId: 'workspace' } }));
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await host.start(settings);
  const configure = (prepare: boolean) => {
    const next = { ...settings, plugins: { reentrant: true }, pluginConfig: { reentrant: { prepare } } };
    return host.configure(next, () => { settings = next; });
  };
  await assert.rejects(configure(true), /during plugin setup, configuration or teardown/);
  await configure(false);
  const committed = settings;
  await assert.rejects(configure(true), /during plugin setup, configuration or teardown/);
  assert.strictEqual(settings, committed);
  await host.prepare('session:session');
});

test('required browser services must survive server mounting, including replacement providers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-required-browser-'));
  const browser = '/packages/ui-runtime/src/browser/boot.js';
  const builtins: PluginDescriptor[] = [
    { id: 'ui', scope: 'application', title: 'UI', description: '', defaultEnabled: true, browser, browserProvides: ['miniTest'] },
    { id: 'replacement', scope: 'application', title: 'Replacement', description: '', browser, browserProvides: ['miniTest'],
      plugin: { apply(_ctx: Context, config: Record<string, unknown>) { if (config.fail) throw new Error('Unavailable replacement'); } } }
  ];
  const settings = { ...structuredClone(DEFAULTS), plugins: { replacement: true },
    browserProviders: { miniTest: 'replacement' }, pluginConfig: { replacement: { fail: true } } };
  const host = new PluginHost(new Context(), directory, builtins, [], () => settings, undefined, undefined, undefined,
    { requiredBrowserServices: new Set(['miniTest']) });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(host.start(settings), /Required browser service is unavailable: miniTest/);
});
