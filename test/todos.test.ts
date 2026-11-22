import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { MiniHarnessRuntime } from '../src/agent.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';

test('Todo state survives reopening without crossing sessions', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const first = runtime.registry.create();
  const second = runtime.registry.create();
  await runtime.send(first.id, 'Track tasks');
  const items = [{ id: 'one', text: 'Verify task', state: 'in-progress' as const }];
  await runtime.setTodos(first.id, items);
  await runtime.stop();
  runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  assert.deepEqual(await runtime.getTodos(first.id), items);
  assert.deepEqual(await runtime.getTodos(second.id), []);
  await assert.rejects(runtime.setTodos(first.id, [...items, ...items]), /Invalid task/);
});
