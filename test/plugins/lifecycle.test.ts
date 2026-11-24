import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '@mini-harness/host/application';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { mergeSettings, readSettings, writeJson } from '@mini-harness/platform/config';

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
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${new URL('../../packages/contracts/plugin-sdk.js', import.meta.url).href}";

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
  await runtime.updateSettings({ plugins: { example: true }, pluginConfig: { example: { prefix: 'Total' } } });
  await runtime.agent.prepare(item.id);
  const activeNames = () => runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name);
  assert.ok(activeNames().includes('example_count'));
  const tool = expectPresent(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'example_count'), 'example count tool');
  assert.equal((await tool.execute('test', {}, undefined, undefined, undefined)).content[0].type, 'text');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /Total: 1/);
  await assert.rejects(runtime.updateSettings({ pluginConfig: { example: { prefix: 12 } } }), /Invalid configuration/);
  assert.equal(runtime.settings.pluginConfig.example.prefix, 'Total');
  await runtime.agent.prepare(item.id);
  assert.match(JSON.stringify(await tool.execute('after-invalid-config', {}, undefined, undefined, undefined)), /Total: 1/);
  assert.equal(activeNames().filter((name) => name === 'example_count').length, 1);
  await runtime.updateSettings({ plugins: { shell: true } });
  assert.throws(() => readFileSync(log), { code: 'ENOENT' }, 'Unrelated switches and invalid config preserve an active plugin');
  await runtime.updateSettings({ plugins: { example: false } });
  assert.equal(readFileSync(log, 'utf8'), 'dispose\n');
  assert.ok(!activeNames().includes('example_count'));
  await assert.rejects(tool.execute('after-unload', {}, undefined, undefined, undefined), /no longer available/);
  await runtime.updateSettings({ plugins: { example: true } });
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
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${new URL('../../packages/contracts/plugin-sdk.js', import.meta.url).href}";
export default (ctx, api) => {
    api.contribute(toolExtensions.register, { name: 'dependent_tool', description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  };`);
  await runtime.start();
  const item = runtime.registry.create();
  await runtime.agent.prepare(item.id);
  const activeNames = () => runtime.plugins.ctx.harnessTools.forSession(item.id).map(({ name }) => name);
  assert.ok(activeNames().includes('read'));
  await runtime.updateSettings({ plugins: { files: false } });
  assert.ok(!activeNames().includes('read'));
  await runtime.updateSettings({ plugins: { files: true, dependent: true } });
  await assert.rejects(runtime.updateSettings({ plugins: { files: false } }), /Required plugin/);
  assert.equal(runtime.settings.plugins.files, true);
  assert.ok(activeNames().includes('dependent_tool'));
  await runtime.updateSettings({ plugins: { files: false, dependent: false } });
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
  await runtime.updateSettings({ plugins: { 'function-entry': true } });
  await runtime.updateSettings({ plugins: { 'named-entry': true } });
  assert.match(runtime.plugins.metadata().find(({ id }) => id === 'named-entry')?.error ?? '', /Export a default setup function/);
  assert.equal(runtime.settings.plugins['function-entry'], true);
  assert.equal(runtime.settings.plugins['named-entry'], true);
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
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${new URL('../../packages/contracts/plugin-sdk.js', import.meta.url).href}";
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
  await runtime.updateSettings({ plugins: { schema: true } });
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
  await assert.rejects(runtime.updateSettings({ pluginConfig: { schema: { count: 0 } } }), /Invalid configuration/);
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
    writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${new URL('../../packages/contracts/plugin-sdk.js', import.meta.url).href}";

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
  await runtime.updateSettings({ plugins: { base: true, dependent: true } });
  await assert.rejects(runtime.updateSettings({ pluginConfig: { base: { fail: true } } }), /Partial setup failed/);
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
  await assert.rejects(runtime.updateSettings({ plugins: { first: true, second: true } }), /Cyclic plugin/);
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
  await assert.rejects(runtime.updateSettings({ plugins: { 'broken-manifest': true } }), /Invalid plugin/);
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
  assert.equal(restored.delegation, undefined);
  assert.match(restored.plugins.metadata().find(({ id }) => id === 'subagents')?.error ?? '', /Invalid configuration/);
  await assert.rejects(restored.updateSettings({ pluginConfig: { subagents: { maxDepth: 101 } } }), /Invalid configuration/);
  await assert.rejects(restored.updateSettings({ pluginConfig: { subagents: { model: { provider: 'unknown', id: 'missing' } } } }), /Unknown child model/);
  await restored.updateSettings({ pluginConfig: { 'core:theme': { appearance: 'dark' } } });
  const conversation = restored.registry.create();
  assert.equal(await restored.runs.send(conversation.id, 'Main agent still works'), 'Mock response');
  await restored.updateSettings({ plugins: { subagents: true }, pluginConfig: { subagents: { maxDepth: 2 } } });
  assert.ok(restored.delegation);
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
  await restarted.updateSettings({ pluginConfig: { 'core:theme': { appearance: 'dark' } } });
  assert.equal(restarted.settings.pluginConfig['core:theme'].appearance, 'dark');
  await restarted.updateSettings({ plugins: { 'fails-to-start': false } });
  assert.equal(expectPresent(restarted.plugins.metadata().find(({ id }) => id === status.id), 'disabled plugin metadata').state, 'disabled');
});
