import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../support/api-fixture.js';
test('an extension owns its authenticated routes and Pi branch records', async (t) => {
  const { app, paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'records');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ protocol: 2, inject: ['harnessRoutes'] }));
  writeFileSync(join(folder, 'plugin.js'), `export default (_ctx, api) => {
    api.registerRoute('POST', '/entries', async ({ body }) => {
      const { id, value } = await body();
      return api.records.append(id, value);
    });
    api.registerRoute('GET', '/entries', ({ url }) => api.records.list(url.searchParams.get('id')));
  };`);
  const toggle = (enabled: boolean) => request('/settings', 'PATCH', { plugins: { records: enabled } });
  assert.equal((await toggle(true)).status, 200);
  const { body: session } = await request('/sessions', 'POST', {});
  await app.runtime.runs.send(session.id, 'Persist this conversation');
  const route = '/extensions/records/entries';
  const value = { note: 'stored by the plugin' };
  const added = await request(route, 'POST', { id: session.id, value });
  assert.equal(added.status, 200);
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await request(route + '?id=' + session.id)).status, 404);

  app.runtime.pi.release(session.id);
  assert.equal((await toggle(true)).status, 200);
  const { body: entries } = await request(route + '?id=' + session.id);
  assert.deepEqual(entries.map(({ id, data }) => ({ id, data })), [{ id: added.body, data: value }]);
  assert.equal(app.runtime.pi.size, 0);
  const fetched = (await request('/sessions/' + session.id)).body;
  assert.equal(fetched.messages.some((message) => JSON.stringify(message).includes(value.note)), false);
});
