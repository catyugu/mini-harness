import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniHarnessRuntime } from '../src/agent.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';

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
  assert.ok((await runtime.open(item.id)).getActiveToolNames().includes('example_count'));
  const tool = runtime.plugins.getTools(item.id).find(({ name }) => name === 'example_count');
  assert.equal((await tool.execute('test', {}, undefined, undefined, undefined)).content[0].type, 'text');
  assert.match(JSON.stringify(await tool.execute('test', {}, undefined, undefined, undefined)), /Total: 1/);
  await assert.rejects(runtime.updateSettings({ pluginConfig: { example: { prefix: 12 } } }), /Invalid prefix/);
  assert.equal(runtime.settings.pluginConfig.example.prefix, 'Total');
  await runtime.updateSettings({ plugins: { example: false } });
  assert.equal(readFileSync(log, 'utf8'), 'dispose\n');
  assert.ok(!(await runtime.open(item.id)).getActiveToolNames().includes('example_count'));
  await runtime.updateSettings({ plugins: { example: true } });
  assert.ok((await runtime.open(item.id)).getActiveToolNames().includes('example_count'));
});
