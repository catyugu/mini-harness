import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../support/api-fixture.js';
test('local plugins install disabled, load UI only when enabled, and uninstall permanently', async (t) => {
  const { paths, request } = await fixture(t);
  const route = '/extensions/gui-plugin/echo';
  const bundle = { id: 'gui-plugin', files: [
    { name: 'plugin.js', content: `export default function(ctx, api) {
      api.registerRoute('POST', '/echo', async ({ body }) => ({ echo: await body() }));
      if (api.config.fail) throw new Error('Setup failed after registering a route');
    }` },
    { name: 'web.js', content: 'export default function(api) {}' }
  ] };
  assert.equal((await request('/plugins/install', 'POST', bundle)).status, 201);
  assert.equal((await request('/plugins/gui-plugin/web')).status, 400);
  assert.equal((await request(route, 'POST', { value: 1 })).status, 404);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'gui-plugin': true } })).status, 200);
  assert.match((await request('/plugins/gui-plugin/web')).body.source, /function/);
  assert.deepEqual((await request(route, 'POST', { value: 1 })).body, { echo: { value: 1 } });
  assert.equal((await request('/settings', 'PATCH', { pluginConfig: { 'gui-plugin': { fail: true } } })).status, 400);
  assert.deepEqual((await request(route, 'POST', { value: 2 })).body, { echo: { value: 2 } });
  assert.equal((await request('/plugins/gui-plugin', 'DELETE')).status, 400);
  await request('/settings', 'PATCH', { plugins: { 'gui-plugin': false } });
  assert.equal((await request(route, 'POST', { value: 2 })).status, 404);
  assert.equal((await request('/plugins/gui-plugin', 'DELETE')).status, 200);
  assert.equal(existsSync(join(paths.plugins, 'gui-plugin')), false);
  const after = (await request('/settings')).body;
  assert.equal(after.plugins['gui-plugin'], undefined);
  assert.equal(after.pluginConfig['gui-plugin'], undefined);
  assert.equal((await request('/plugins/install', 'POST', { ...bundle, files: [{ name: '../escape.js', content: '' }] })).status, 400);
  assert.equal((await request('/plugins/install', 'POST', { ...bundle, files: [...bundle.files, { name: 'plugin.json', content: JSON.stringify({ requires: 'invalid' }) }] })).status, 400);
  assert.equal((await request('/bootstrap')).status, 200);
  assert.equal(existsSync(join(paths.plugins, 'gui-plugin')), false);
});
