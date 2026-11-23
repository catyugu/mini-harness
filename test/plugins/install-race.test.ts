import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { fixture, waitUntil } from '../support/api-fixture.js';

test('plugin file writes wait for an in-flight plugin configuration', async (t) => {
  const { paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'slow-plugin');
  const entered = join(folder, 'entered');
  const release = join(folder, 'release');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), `import { existsSync, writeFileSync } from 'node:fs';
    export default async () => {
      writeFileSync(${JSON.stringify(entered)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 10));
    };`);
  const updating = request('/settings', 'PATCH', { plugins: { 'slow-plugin': true } });
  try {
    await waitUntil(() => existsSync(entered), Boolean);
    const installation = await request('/plugins/install', 'POST', {
      id: 'another-plugin', files: [{ name: 'plugin.js', content: 'export default () => {};' }]
    });
    assert.equal(installation.status, 400);
    assert.match(installation.body.error, /Configuration is already changing/);
    const removal = await request('/plugins/slow-plugin', 'DELETE');
    assert.equal(removal.status, 400);
    assert.match(removal.body.error, /Configuration is already changing/);
    assert.equal(existsSync(folder), true);
  } finally {
    writeFileSync(release, 'done');
    assert.equal((await updating).status, 200);
  }
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'slow-plugin': false } })).status, 200);
  assert.equal((await request('/plugins/slow-plugin', 'DELETE')).status, 200);
  assert.equal(existsSync(folder), false);
});
