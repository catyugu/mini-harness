import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createMiniHarnessServer } from '../../packages/host/server.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('compiled browser tests and host-only feature code are not public static assets', async (t) => {
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
  for (const asset of [
    '/packages/settings/tests/browser-layout.spec.js',
    '/packages/sessions/tests/browser-navigation.spec.js',
    '/packages/agent/pi-sessions.js',
    '/packages/shell/host.js',
    '/packages/subagents/delegation.js'
  ]) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 404, asset);
  }
  const publicAsset = await fetch(base + '/packages/web/ui/components/primitives.js');
  assert.equal(publicAsset.status, 200);
});
