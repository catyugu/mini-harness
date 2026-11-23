import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createMiniHarnessServer } from '@mini-harness/host/server';
import { SessionRegistry } from '@mini-harness/sessions/registry';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';
import type { RunEvent } from '@mini-harness/contracts/transport';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

function gate() {
  let release: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release: () => release() };
}

test('HTTP disconnect keeps the native run alive and reconnect replays from a cursor', { timeout: 15000 }, async (t) => {
  const entered = gate(), held = gate();
  const mock = await createMockProvider(async () => { entered.release(); await held.promise; return 'Reconnected response'; });
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { held.release(); await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const item = app.runtime.registry.create();
  const controller = new AbortController();
  const start = await fetch(base + '/api/sessions/' + item.id + '/runs', {
    method: 'POST', headers, body: JSON.stringify({ message: 'Keep working' })
  });
  assert.equal(start.status, 202);
  const { id: runId } = await start.json();
  const response = await fetch(base + '/api/sessions/' + item.id + '/events?run=' + runId, {
    headers, signal: controller.signal
  });
  assert.equal(response.status, 200);
  await entered.promise;
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value).trim().split('\n').map((line) => JSON.parse(line));
  const cursor = first.at(-1).sequence;
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.equal(app.runtime.runs.active(item.id), true);
  const status = await (await fetch(base + '/api/sessions/' + item.id + '/runs', { headers })).json();
  assert.equal(status.run.state, 'running');
  const pending = app.runtime.runs.completion(item.id);
  const replay = fetch(base + '/api/sessions/' + item.id + '/events?run=' + status.run.id + '&after=' + cursor, { headers });
  held.release();
  await pending;
  const events = (await (await replay).text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.every((event) => event.sequence > cursor));
  assert.ok(events.some((event) => event.type === 'complete' || event.type === 'snapshot'));
  assert.equal(app.runtime.runs.info(item.id).state, 'completed');
  const durable = readFileSync(app.runtime.registry.nativeFile(item), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(durable.filter((entry) => entry.type === 'run').at(-1).run.state, 'completed');
});

test('independent roots run concurrently and deleting a running tree cancels all descendants', { timeout: 15000 }, async (t) => {
  const held = gate();
  const entered = gate();
  let requests = 0;
  const mock = await createMockProvider(async () => { if (++requests === 2) entered.release(); await held.promise; return 'Done'; });
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { held.release(); await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const parent = app.runtime.registry.create(), other = app.runtime.registry.create();
  const first = app.runtime.runs.send(parent.id, 'Root one');
  const cancelled = assert.rejects(first, /cancelled/);
  const second = app.runtime.runs.send(other.id, 'Root two');
  await entered.promise;
  assert.equal(app.runtime.runs.size, 2);
  const child = app.runtime.registry.create({ parentId: parent.id });
  const childWork = app.runtime.runs.send(child.id, 'Child');
  const childCancelled = assert.rejects(childWork, /cancelled/);
  const deleted = await app.runtime.delete([parent.id]);
  await Promise.all([cancelled, childCancelled]);
  assert.deepEqual(new Set(deleted), new Set([parent.id, child.id]));
  assert.equal(app.runtime.registry.get(parent.id), undefined);
  assert.equal(app.runtime.runs.active(other.id), true);
  held.release();
  assert.equal(await second, 'Done');
  assert.equal(app.runtime.delegation.activeChildren, 0);
});

test('a crash leaves indexed runs interrupted while retaining the conversation tree', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  t.after(async () => { await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  const parent = registry.create(), child = registry.create({ parentId: parent.id });
  registry.log(child.id).append({ type: 'run', run: { id: 'fixture-run', sessionId: child.id, state: 'running', startedAt: new Date().toISOString(), sequence: 1 } });
  registry.dispose();
  const restored = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  t.after(() => restored.dispose());
  assert.equal(restored.log(child.id).projection().run.state, 'interrupted');
  assert.deepEqual(restored.descendants([parent.id]), [parent.id, child.id]);
  assert.equal(existsSync(paths.registry), true);
});

test('child queues honor live limits, explicit cancellation, and depth restrictions', { timeout: 15000 }, async (t) => {
  const held = [gate(), gate(), gate()];
  const entered = [gate(), gate(), gate()];
  let requests = 0;
  const mock = await createMockProvider(async () => {
    const index = requests++;
    entered[index].release();
    await held[index].promise;
    return 'Done';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { for (const gate of held) gate.release(); await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await app.runtime.updateSettings({ pluginConfig: { subagents: { maxParallel: 1 } } });
  const parent = app.runtime.registry.create();
  const choice = { provider: 'local-mock', id: 'mock-model' };
  const first = app.runtime.delegation.run(parent.id, 'First child', choice);
  await entered[0].promise;
  const second = app.runtime.delegation.run(parent.id, 'Second child', choice);
  const third = app.runtime.delegation.run(parent.id, 'Cancelled queued child', choice);
  const aborted = assert.rejects(third, /cancelled/);
  const records = app.runtime.registry.list();
  const queued = records.find(({ title }) => title === 'Cancelled queued child');
  assert.equal(app.runtime.runs.info(queued.id).state, 'queued');
  app.runtime.runs.cancel(queued.id);
  await aborted;
  assert.equal(app.runtime.runs.info(queued.id).state, 'cancelled');
  assert.equal(requests, 1);
  await app.runtime.updateSettings({ pluginConfig: { subagents: { maxParallel: 2 } } });
  await entered[1].promise;
  assert.equal(app.runtime.delegation.activeChildren, 2);
  await app.runtime.updateSettings({ pluginConfig: { subagents: { maxParallel: 1 } } });
  assert.equal(app.runtime.runs.size, 2, 'Lowering the limit preserves existing executions');
  const child = app.runtime.registry.list().find(({ title }) => title === 'First child');
  await assert.rejects(app.runtime.delegation.run(child.id, 'Too deep', choice), /depth limit/);
  held[0].release(); held[1].release();
  await Promise.all([first, second]);
  assert.equal(app.runtime.delegation.activeChildren, 0);
  assert.equal(requests, 2, 'Cancelled queued children never reach the provider');
});

test('late observers receive a saved snapshot and stale cursors cannot attach to a newer run', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const item = app.runtime.registry.create();
  await app.runtime.runs.send(item.id, 'First');
  const first = app.runtime.runs.info(item.id);
  const events: RunEvent[] = [];
  app.runtime.runs.watch(item.id, first.id, 0, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'snapshot');
  assert.ok(events[0].type === 'snapshot' && events[0].messages.some(({ role }) => role === 'assistant'));
  await app.runtime.runs.send(item.id, 'Second');
  assert.throws(() => app.runtime.runs.watch(item.id, first.id, 0, () => {}), /Run not found/);
  assert.throws(() => app.runtime.runs.watch(item.id, app.runtime.runs.info(item.id).id, Number.NaN, () => {}), /Invalid event cursor/);
});
