import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../support/api-fixture.js';
test('an extension owns its authenticated routes and native branch records without starting an agent', async (t) => {
  const { app, paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'records');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ inject: ['harnessSessions'] }));
  writeFileSync(join(folder, 'plugin.js'), `import { sessionExtensions } from "${new URL('../../packages/sdk/src/plugin.js', import.meta.url).href}";
export default (_ctx, api) => {
    const records = api.contribute(sessionExtensions.records);
    api.registerRoute('POST', '/entries', async ({ body }) => {
      const { id, value } = await body();
      return records.append(id, value);
    });
    api.registerRoute('GET', '/entries', ({ url }) => records.list(url.searchParams.get('id')));
    const notes = records.projection({
      initial: () => [],
      reduce: (state, { data }) => [...state, data.note]
    });
    api.registerRoute('GET', '/notes', ({ url }) => notes.read(url.searchParams.get('id')));
  };`);
  const toggle = (enabled: boolean) => request('/settings', 'PATCH', { plugins: { records: enabled } });
  assert.equal((await toggle(true)).status, 200);
  const { body: session } = await request('/sessions', 'POST', {});
  await app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Persist this conversation');
  const route = '/extensions/records/entries';
  const value = { note: 'stored by the plugin' };
  const beforePluginRecords = app.runtime.plugins.ctx.harnessRegistry.log(session.id).projection().leafId;
  const notes = '/extensions/records/notes?id=' + session.id;
  const added = await request(route, 'POST', { id: session.id, value });
  assert.equal(added.status, 200);
  assert.deepEqual((await request(notes)).body, [value.note]);
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await request(route + '?id=' + session.id)).status, 404);

  assert.equal((await toggle(true)).status, 200);
  const { body: entries } = await request(route + '?id=' + session.id);
  assert.deepEqual(entries.map(({ id, data }: { id: string; data: unknown }) => ({ id, data })), [{ id: added.body, data: value }]);
  assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 0);
  const saved = app.runtime.plugins.ctx.harnessRegistry.export([session.id])[0].log;
  assert.ok(saved.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .some((entry) => entry.type === 'custom' && entry.namespace === 'records' && entry.data.note === value.note));
  const fetched = (await request('/sessions/' + session.id)).body;
  assert.equal(fetched.messages.some((message: { content: unknown }) => JSON.stringify(message).includes(value.note)), false);
  const log = app.runtime.plugins.ctx.harnessRegistry.log(session.id);
  log.revise({ type: 'message', message: { role: 'user', content: 'New branch', timestamp: Date.now() } },
    beforePluginRecords, log.projection().leafId);
  assert.deepEqual((await request(notes)).body, []);
  assert.ok(log.entries().some(({ id }) => id === added.body));
});
