import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MiniHarnessRuntime } from '../../packages/host/application.js';
import { writeJson } from '../../packages/platform/config.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('the one-time index upgrade preserves Pi history and moves run recovery to its owner', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => {
    await runtime.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });

  await runtime.start();
  const parent = runtime.registry.create();
  await runtime.runs.send(parent.id, 'Persist history before upgrade');
  const record = runtime.registry.get(parent.id);
  const child = runtime.registry.create({ parentId: parent.id });
  const run = runtime.runs.info(parent.id);
  const original = readFileSync(record.piSessionRef, 'utf8');
  await runtime.stop();
  rmSync(join(paths.home, 'runs.json'));
  const old = ({ titleSource: _source, piSessionRef, ...identity }: typeof record) => ({
    ...identity, cwd: paths.cwd, model: { provider: 'local-mock', id: 'mock-model' },
    file: piSessionRef, updatedAt: run.startedAt
  });
  writeJson(paths.registry, { sessions: [{ ...old(record), run: { ...run, state: 'running' } }, old(child)] });

  runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  assert.deepEqual(runtime.registry.descendants([parent.id]), [parent.id, child.id]);
  assert.equal(runtime.runs.info(parent.id).state, 'interrupted');
  const catalog = JSON.parse(readFileSync(paths.registry, 'utf8'));
  assert.equal(catalog.version, 2);
  assert.deepEqual(Object.keys(catalog.sessions[0]).sort(), ['createdAt', 'id', 'parentId', 'piSessionRef', 'title', 'titleSource', 'workspaceId']);
  assert.equal(runtime.pi.read(parent.id).messages.at(-1).role, 'assistant');
  assert.equal(runtime.pi.size, 0);
  assert.equal(readFileSync(record.piSessionRef, 'utf8'), original);
});
