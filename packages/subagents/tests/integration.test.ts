import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../../host/server.js';
import { createMockProvider, createFixturePaths } from '../../../test/helpers/mock-provider.js';

test('subagent tool is mounted in parent only, with an explicit concurrency limit', { timeout: 30000 }, async (t) => {
  const mock = await createMockProvider();
  t.after(() => mock.close());
  const { root, paths } = createFixturePaths(mock.url);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await createMiniHarnessServer(paths);
  t.after(() => app.close());
  const rootSession = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: rootSession.id });
  const parent = await app.runtime.pi.open(rootSession.id);
  const worker = await app.runtime.pi.open(child.id);
  assert.ok(parent.getActiveToolNames().includes('delegate'));
  assert.ok(!worker.getActiveToolNames().includes('delegate'));
  assert.equal(app.runtime.delegation.parallelLimit, 4);
});

test('Pi honors file policy and recursive delegates can finish with one slot', { timeout: 30000 }, async (t) => {
  const mock = await createMockProvider(({ messages }) => {
    const last = messages.at(-1);
    if (last.role === 'tool') return 'Finished ' + ([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
    if (last.content === 'root task') return { tool: 'delegate', args: { task: 'child task', provider: 'local-mock' } };
    if (last.content === 'child task') return { tool: 'delegate', args: { task: 'leaf task' } };
    if (last.content === 'read policy') return { tool: 'read', args: { path: '../outside.txt' } };
    return 'Leaf finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  let app = await createMiniHarnessServer(paths);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'outside.txt'), 'private fixture');
  await app.runtime.updateSettings({ pluginConfig: { subagents: { maxDepth: 2, maxParallel: 1, provider: 'local-mock', model: 'mock-model' } } });
  const parent = app.runtime.registry.create();
  const toolEvents = [];
  await app.runtime.runs.send(parent.id, 'root task', (event) => { if (event.type === 'tool') toolEvents.push(event); });
  const records = app.runtime.registry.descendants([parent.id]).map((id) => app.runtime.registry.get(id));
  assert.deepEqual(records.map(({ title }) => title), ['root task', 'child task', 'leaf task']);
  assert.deepEqual(app.runtime.registry.get(records[2].id).model, { provider: 'local-mock', id: 'mock-model' });
  assert.equal((await app.runtime.pi.open(records[2].id)).getActiveToolNames().includes('delegate'), false);
  assert.ok(toolEvents.some((event) => event.state === 'finished' && event.sessionId === records[1].id));
  const check = app.runtime.registry.create();
  await app.runtime.runs.send(check.id, 'read policy');
  const failure = app.runtime.pi.messages(check.id).find((message) => message.role === 'toolResult');
  assert.equal(failure.isError, true);
  assert.match(JSON.stringify(failure.content), /permitted workspace/);
  assert.doesNotMatch(JSON.stringify(failure.content), /private fixture/);
  await app.close();
  app = await createMiniHarnessServer(paths);
  const exported = app.runtime.export([parent.id, records[1].id]);
  assert.deepEqual(exported.map(({ id, parentId }) => ({ id, parentId })),
    records.map(({ id, parentId }) => ({ id, parentId })));
  assert.ok(exported.every(({ piSession }) => piSession?.includes('"type":"session"')));
  assert.equal((await app.runtime.getConversation(records[2].id)).model.id, 'mock-model');
});

test('cancelling a root aborts its active child and preserves indexed history', { timeout: 15000 }, async (t) => {
  let entered: () => void;
  let release: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1)?.content === 'start child') return { tool: 'delegate', args: { task: 'hold child' } };
    entered();
    await held;
    return 'Released';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { release(); await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const parent = app.runtime.registry.create();
  const pending = app.runtime.runs.send(parent.id, 'start child');
  const aborted = assert.rejects(pending, /cancelled/);
  await waiting;
  assert.equal(app.runtime.runs.size, 2);
  assert.equal(app.runtime.runs.cancel(parent.id), true);
  await aborted;
  assert.equal(app.runtime.runs.size, 0);
  assert.equal(app.runtime.delegation.activeChildren, 0);
  const child = app.runtime.export([parent.id])[1];
  assert.equal(child.title, '[Cancelled] hold child');
  assert.ok(child.piSession?.includes('hold child'));
});

