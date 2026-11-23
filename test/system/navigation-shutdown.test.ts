import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createMiniHarnessServer } from '../../packages/host/server.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('navigation stream is disposed before HTTP shutdown completes', { timeout: 15000 }, async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await app.listen(0);
  const response = await fetch('http://127.0.0.1:' + port + '/api/navigation/events', {
    headers: { Authorization: 'Bearer ' + app.token }
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false, 'the initial snapshot arrives on an open stream');

  let alarm: NodeJS.Timeout;
  const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      alarm = setTimeout(() => reject(new Error('Navigation stream held the server open')), 10000);
      alarm.unref();
    })
  ]).finally(() => clearTimeout(alarm));

  try {
    await bounded(app.close());
    const tail = await bounded(reader.read());
    assert.equal(tail.done, true, 'the server gracefully terminates the navigation stream');
  } finally {
    await reader.cancel().catch(() => {});
  }
});
