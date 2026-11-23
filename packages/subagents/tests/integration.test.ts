import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '@mini-harness/host/server';
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
  await Promise.all([app.runtime.agent.prepare(rootSession.id), app.runtime.agent.prepare(child.id)]);
  const names = (id: string) => app.runtime.plugins.ctx.harnessTools.forSession(id).map(({ name }) => name);
  assert.ok(names(rootSession.id).includes('delegate'));
  assert.ok(!names(child.id).includes('delegate'));
  assert.ok(app.runtime.delegation);
  assert.equal(app.runtime.delegation.parallelLimit, 4);
});

test('Native execution honors file policy and recursive delegates can finish with one slot', { timeout: 30000 }, async (t) => {
  const mock = await createMockProvider(({ messages }) => {
    const last = messages.at(-1);
    assert.ok(last);
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
  const toolEvents: Extract<import('@mini-harness/contracts/transport').StreamEvent, { type: 'tool' }>[] = [];
  await app.runtime.runs.send(parent.id, 'root task', (event) => { if (event.type === 'tool') toolEvents.push(event); });
  const records = app.runtime.registry.descendants([parent.id]).map((id) => app.runtime.registry.get(id));
  assert.deepEqual(records.map((record) => { assert.ok(record); return record.title; }), ['root task', 'child task', 'leaf task']);
  const childRecord = records[1], leafRecord = records[2];
  assert.ok(childRecord && leafRecord);
  assert.deepEqual(app.runtime.agent.read(leafRecord.id).model, { provider: 'local-mock', id: 'mock-model' });
  assert.equal(app.runtime.plugins.ctx.harnessTools.forSession(leafRecord.id).map(({ name }) => name).includes('delegate'), false);
  assert.ok(toolEvents.some((event) => event.state === 'finished' && event.sessionId === childRecord.id));
  const check = app.runtime.registry.create();
  await app.runtime.runs.send(check.id, 'read policy');
  const failure = app.runtime.agent.messages(check.id).find((message) => message.role === 'toolResult');
  assert.ok(failure);
  assert.equal(failure.isError, true);
  assert.match(JSON.stringify(failure.content), /permitted workspace/);
  assert.doesNotMatch(JSON.stringify(failure.content), /private fixture/);
  await app.close();
  app = await createMiniHarnessServer(paths);
  const exported = app.runtime.export([parent.id, childRecord.id]);
  assert.deepEqual(exported.map(({ id, parentId }) => ({ id, parentId })),
    records.map((record) => { assert.ok(record); return { id: record.id, parentId: record.parentId }; }));
  assert.ok(exported.every(({ log }) => log?.includes('"type":"session"')));
  assert.equal((await app.runtime.getConversation(leafRecord.id))?.model?.id, 'mock-model');
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
  assert.ok(app.runtime.delegation);
  assert.equal(app.runtime.delegation.activeChildren, 0);
  const child = app.runtime.export([parent.id])[1];
  assert.ok(child);
  assert.equal(child.title, '[Cancelled] hold child');
  assert.ok(child.log?.includes('hold child'));
});

