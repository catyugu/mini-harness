import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '@mini-harness/host/server';
import { fixture, waitUntil } from '../../../test/support/api-fixture.js';
import { expectPresent } from '../../../test/support/required.js';
import { createMockProvider, createFixturePaths } from '../../../test/helpers/mock-provider.js';

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
  await app.runtime.configuration.update({ pluginConfig: { subagents: { maxDepth: 2, maxParallel: 1, model: { provider: 'local-mock', id: 'mock-model' } } } });
  const parent = app.runtime.registry.create();
  const toolEvents: Extract<import('@mini-harness/runs/stream').StreamEvent, { type: 'tool' }>[] = [];
  await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'root task', (event) => { if (event.type === 'tool') toolEvents.push(event); });
  const records = app.runtime.registry.descendants([parent.id]).map((id) => app.runtime.registry.get(id));
  assert.deepEqual(records.map((record) => { assert.ok(record); return record.title; }), ['root task', 'child task', 'leaf task']);
  const childRecord = records[1], leafRecord = records[2];
  assert.ok(childRecord && leafRecord);
  assert.deepEqual(app.runtime.registry.log(leafRecord.id).projection().model, { provider: 'local-mock', id: 'mock-model' });
  assert.equal(app.runtime.plugins.ctx.harnessTools.forSession(leafRecord.id).map(({ name }) => name).includes('delegate'), false);
  assert.ok(toolEvents.some((event) => event.state === 'finished' && event.sessionId === childRecord.id));
  const check = app.runtime.registry.create();
  await app.runtime.plugins.ctx.harnessRuns.send(check.id, 'read policy');
  const failure = app.runtime.registry.log(check.id).projection().messages.find((message) => message.role === 'toolResult');
  assert.ok(failure);
  assert.equal(failure.isError, true);
  assert.match(JSON.stringify(failure.content), /permitted workspace/);
  assert.doesNotMatch(JSON.stringify(failure.content), /private fixture/);
  await app.close();
  app = await createMiniHarnessServer(paths);
  const exported = app.runtime.registry.export([parent.id, childRecord.id]);
  assert.deepEqual(exported.map(({ id, parentId }) => ({ id, parentId })),
    records.map((record) => { assert.ok(record); return { id: record.id, parentId: record.parentId }; }));
  assert.ok(exported.every(({ log }) => log?.includes('"type":"session"')));
  assert.equal(app.runtime.registry.log(leafRecord.id).projection().model?.id, 'mock-model');
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
  const pending = app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'start child');
  const aborted = assert.rejects(pending, /cancelled/);
  await waiting;
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 2);
  assert.equal(app.runtime.plugins.ctx.harnessRuns.cancel(parent.id), true);
  await aborted;
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 0);
  const child = app.runtime.registry.export([parent.id])[1];
  assert.ok(child);
  assert.equal(child.title, '[Cancelled] hold child');
  assert.ok(child.log?.includes('hold child'));
});

function gate() {
  let release: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release: () => release() };
}

test('child queues honor live limits, explicit cancellation, and depth restrictions', { timeout: 15000 }, async (t) => {
  const held = [gate(), gate(), gate()];
  const entered = [gate(), gate(), gate()];
  let requests = 0;
  t.after(() => { for (const gate of held) gate.release(); });
  const { app } = await fixture(t, async () => {
    const index = requests++;
    const ready = entered[index], gate = held[index];
    assert.ok(ready && gate, 'Mock received more requests than expected');
    ready.release();
    await gate.promise;
    return 'Done';
  });
  await app.runtime.configuration.update({ pluginConfig: { subagents: { maxParallel: 1 } } });
  const parent = app.runtime.registry.create();
  const tools = app.runtime.plugins.ctx.harnessTools;
  const delegate = expectPresent(tools.forSession(parent.id).find(({ name }) => name === 'delegate'), 'delegate tool');
  const start = (task: string) => delegate.execute(task, { task, provider: 'local-mock', model: 'mock-model' });
  const first = start('First child');
  assert.ok(entered[0] && entered[1]);
  await entered[0].promise;
  const second = start('Second child');
  const third = start('Cancelled queued child');
  const aborted = assert.rejects(third, /cancelled/);
  const queued = await waitUntil(() => app.runtime.registry.list().find(({ title }) => title === 'Cancelled queued child'), Boolean);
  assert.ok(queued);
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(queued.id)?.state, 'queued');
  app.runtime.plugins.ctx.harnessRuns.cancel(queued.id);
  await aborted;
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(queued.id)?.state, 'cancelled');
  assert.equal(requests, 1);
  await app.runtime.configuration.update({ pluginConfig: { subagents: { maxParallel: 2 } } });
  await entered[1].promise;
  await app.runtime.configuration.update({ pluginConfig: { subagents: { maxParallel: 1 } } });
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 2, 'Lowering the limit preserves existing executions');
  const child = app.runtime.registry.list().find(({ title }) => title === 'First child');
  assert.ok(child);
  assert.equal(tools.forSession(child.id).some(({ name }) => name === 'delegate'), false);
  assert.ok(held[0] && held[1]);
  held[0].release(); held[1].release();
  await Promise.all([first, second]);
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 0);
  assert.equal(requests, 2, 'Cancelled queued children never reach the provider');
});
