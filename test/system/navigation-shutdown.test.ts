import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createMiniHarnessServer } from '@mini-harness/host/server';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('HTTP shutdown cancels active requests and closes projection streams', { timeout: 15000 }, async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + app.token };
  let markEntered = () => {};
  const requestEntered = new Promise<void>((resolve) => { markEntered = resolve; });
  const release = app.runtime.plugins.ctx.harnessRoutes.register('GET', '/api/fixture-pending', async ({ signal }) => {
    const cancelled = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    markEntered();
    await cancelled;
  });
  t.after(release);
  const response = await fetch(base + '/api/changes', { headers });
  assert.equal(response.status, 200);
  if (!response.body) throw new Error('No streaming response body');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false, 'the initial snapshot arrives on an open stream');

  let alarm: NodeJS.Timeout;
  const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      alarm = setTimeout(() => reject(new Error('Projection stream held the server open')), 10000);
      alarm.unref();
    })
  ]).finally(() => clearTimeout(alarm));

  try {
    const pending = fetch(base + '/api/fixture-pending', { headers });
    await bounded(requestEntered);
    const stopping = app.close();
    const cancelled = await bounded(pending);
    assert.equal(cancelled.status, 503);
    assert.equal((await cancelled.json()).code, 'unavailable');
    await bounded(stopping);
    const tail = await bounded(reader.read());
    assert.equal(tail.done, true, 'the server gracefully terminates the projection stream');
  } finally {
    await reader.cancel().catch(() => {});
  }
});
