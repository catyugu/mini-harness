import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '../src/application.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';
import { mergeSettings } from '../src/config.js';

test('an installed Cordis plugin can use services, configure a tool, and release resources', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });

  const folder = join(paths.plugins, 'example');
  const log = join(folder, 'effects.log');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ title: 'Example plugin' }));
  writeFileSync(join(folder, 'plugin.js'), `
    import { appendFileSync } from 'node:fs';
    export const inject = ['harnessSessions'];
    export default (ctx, api) => {
      const config = api.defineConfig({ prefix: 'Count' }, (value) => {
        if (typeof value.prefix !== 'string') throw new Error('Invalid prefix');
      });
      api.onDispose(() => appendFileSync(${JSON.stringify(log)}, 'dispose\\n'));
      api.registerTool({
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
  await runtime.updateSettings({ plugins: { example: true }, pluginConfig: { example: { prefix: 'Total' } } });
  const originalSession = await runtime.pi.open(item.id);
  assert.ok(originalSession.getActiveToolNames().includes('example_count'));
  const tool = runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'example_count');
  assert.equal((await tool.execute('test', {}, undefined, undefined, undefined)).content[0].type, 'text');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /Total: 1/);
  await assert.rejects(runtime.updateSettings({ pluginConfig: { example: { prefix: 12 } } }), /Invalid prefix/);
  assert.equal(runtime.settings.pluginConfig.example.prefix, 'Total');
  const restoredSession = await runtime.pi.open(item.id);
  assert.notStrictEqual(restoredSession, originalSession);
  assert.ok(restoredSession.getActiveToolNames().includes('example_count'));
  assert.equal(readFileSync(log, 'utf8'), 'dispose\n');
  await runtime.updateSettings({ plugins: { shell: true } });
  assert.equal(readFileSync(log, 'utf8'), 'dispose\n', 'Unrelated switches should preserve an active plugin');
  await runtime.updateSettings({ plugins: { example: false } });
  assert.equal(readFileSync(log, 'utf8'), 'dispose\ndispose\n');
  assert.ok(!(await runtime.pi.open(item.id)).getActiveToolNames().includes('example_count'));
  await runtime.updateSettings({ plugins: { example: true } });
  assert.ok((await runtime.pi.open(item.id)).getActiveToolNames().includes('example_count'));
});

test('file tools have a plugin lifecycle and required plugins cannot be disabled independently', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'dependent');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ requires: ['files'] }));
  writeFileSync(join(folder, 'plugin.js'), `export default (ctx, api) => {
    api.registerTool({ name: 'dependent_tool', description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  };`);
  await runtime.start();
  const item = runtime.registry.create();
  assert.ok((await runtime.pi.open(item.id)).getActiveToolNames().includes('read'));
  await runtime.updateSettings({ plugins: { files: false } });
  assert.ok(!(await runtime.pi.open(item.id)).getActiveToolNames().includes('read'));
  await runtime.updateSettings({ plugins: { files: true, dependent: true } });
  await assert.rejects(runtime.updateSettings({ plugins: { files: false } }), /Required plugin/);
  assert.equal(runtime.settings.plugins.files, true);
  assert.ok((await runtime.pi.open(item.id)).getActiveToolNames().includes('dependent_tool'));
  await runtime.updateSettings({ plugins: { files: false, dependent: false } });
  assert.equal(runtime.plugins.ctx.harnessTools.forSession(item.id).some(({ name }) => name === 'read' || name === 'dependent_tool'), false);
});

test('plugin JSON Schema applies defaults and rejects invalid changes before setup', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const folder = join(paths.plugins, 'schema');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ configSchema: {
    type: 'object', additionalProperties: false, required: ['count'],
    properties: { count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      options: { type: 'object', default: {}, properties: { enabled: { type: 'boolean', default: true } } } }
  } }));
  writeFileSync(join(folder, 'plugin.js'), `export default (ctx, api) => {
    api.registerTool({ name: 'schema_value', description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: String(api.config.count) + ':' + api.config.options.enabled }] }) });
  };`);
  await runtime.start();
  await runtime.updateSettings({ plugins: { schema: true } });
  const item = runtime.registry.create();
  const tool = runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'schema_value');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /3:true/);
  await assert.rejects(runtime.updateSettings({ pluginConfig: { schema: { count: 0 } } }), /Invalid configuration/);
  assert.strictEqual(runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'schema_value'), tool);
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
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ requires: id === 'dependent' ? ['base'] : [] }));
    writeFileSync(join(folder, 'plugin.js'), `
      import { appendFileSync } from 'node:fs';
      export default (ctx, api) => {
        appendFileSync(${JSON.stringify(log)}, 'start ${id}\\n');
        api.onDispose(() => appendFileSync(${JSON.stringify(log)}, 'stop ${id}\\n'));
        api.registerTool({ name: '${id}_tool', description: 'Fixture', parameters: {type: 'object', properties: {}},
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
  const restored = runtime.plugins.ctx.harnessTools.forSession(item.id).find(({ name }) => name === 'base_tool');
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
