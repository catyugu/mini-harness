import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createMiniHarnessServer } from '../src/server.js';
import { SessionRegistry } from '../src/registry.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';

function gate() {
  let release: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release: () => release() };
}

test('HTTP disconnect keeps the Pi run alive and reconnect replays from a cursor', { timeout: 15000 }, async (t) => {
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
  const response = await fetch(base + '/api/sessions/' + item.id + '/messages', {
    method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ message: 'Keep working' })
  });
  assert.equal(response.status, 200);
  await entered.promise;
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value).trim().split('\n').map((line) => JSON.parse(line));
  const cursor = first.at(-1).sequence;
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.equal(app.runtime.busy.has(item.id), true);
  const status = await (await fetch(base + '/api/sessions/' + item.id + '/runs', { headers })).json();
  assert.equal(status.run.state, 'running');
  const pending = app.runtime.busy.get(item.id).done;
  const replay = fetch(base + '/api/sessions/' + item.id + '/events?run=' + status.run.id + '&after=' + cursor, { headers });
  held.release();
  await pending;
  const events = (await (await replay).text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.every((event) => event.sequence > cursor));
  assert.ok(events.some((event) => event.type === 'complete' || event.type === 'snapshot'));
  assert.equal(app.runtime.runInfo(item.id).state, 'completed');
  const restored = new SessionRegistry(paths);
  assert.equal(restored.get(item.id).run.state, 'completed');
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
  const first = app.runtime.send(parent.id, 'Root one');
  const cancelled = assert.rejects(first, /cancelled/);
  const second = app.runtime.send(other.id, 'Root two');
  await entered.promise;
  assert.equal(app.runtime.busy.size, 2);
  const child = app.runtime.registry.create({ parentId: parent.id });
  const childWork = app.runtime.send(child.id, 'Child');
  const childCancelled = assert.rejects(childWork, /cancelled/);
  const deleted = await app.runtime.delete([parent.id]);
  await Promise.all([cancelled, childCancelled]);
  assert.deepEqual(new Set(deleted), new Set([parent.id, child.id]));
  assert.equal(app.runtime.registry.get(parent.id), undefined);
  assert.equal(app.runtime.busy.has(other.id), true);
  held.release();
  assert.equal(await second, 'Done');
  assert.equal(app.runtime.semaphore.active, 0);
});

test('a crash leaves indexed runs interrupted while retaining the conversation tree', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  t.after(async () => { await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const registry = new SessionRegistry(paths);
  const parent = registry.create(), child = registry.create({ parentId: parent.id });
  registry.update(child.id, { run: { id: 'fixture-run', sessionId: child.id, state: 'running', startedAt: new Date().toISOString(), sequence: 1 } });
  const restored = new SessionRegistry(paths);
  assert.equal(restored.get(child.id).run.state, 'interrupted');
  assert.deepEqual(restored.descendants([parent.id]), [parent.id, child.id]);
  assert.equal(existsSync(paths.registry), true);
});
