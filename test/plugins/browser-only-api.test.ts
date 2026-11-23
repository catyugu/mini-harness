import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../support/api-fixture.js';

test('web-only plugins install and unload without a dummy backend entry', async (t) => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/plugins/install', 'POST', {
    id: 'browser-only', files: [{ name: 'plugin.json', content: JSON.stringify({ browserRequires: ['core:conversation'] }) }, { name: 'web.js', content: 'export default (_ctx, api) => api.command({name:"browser-only",description:"Test"});' }]
  })).status, 201);
  assert.ok(!(await request('/bootstrap')).body.ui.some((entry: { id: string }) => entry.id === 'browser-only'));
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'browser-only': true } })).status, 200);
  const browser = (await request('/bootstrap')).body.ui.find((entry: { id: string }) => entry.id === 'browser-only').browser;
  assert.match(await (await fetch(base + browser)).text(), /browser-only/);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'browser-only': false } })).status, 200);
  assert.equal((await fetch(base + browser)).status, 404);
  assert.equal((await request('/plugins/browser-only', 'DELETE')).status, 200);
  const settings = (await request('/settings')).body;
  assert.equal(settings.plugins['browser-only'], undefined);
  assert.equal(settings.pluginConfig['browser-only'], undefined);
});
