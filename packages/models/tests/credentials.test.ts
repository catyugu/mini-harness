import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../../host/server.js';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

test('credential settings persist atomically and do not return secrets', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const port = await app.listen(0);
  const response = await fetch('http://127.0.0.1:' + port + '/api/credentials', {
    method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'anthropic', key: 'fixture-secret' })
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.doesNotMatch(await response.text(), /fixture-secret/);
  assert.equal(JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8')).anthropic.key, 'fixture-secret');
});
