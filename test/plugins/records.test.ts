import { sendRun, activeRunCount } from '../support/runs.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../support/api-fixture.ts';
test('an extension owns its authenticated routes and native branch records without starting an agent', async (t) => {
  const { app, paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'records');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
  writeFileSync(
    join(folder, 'plugin.js'),
    `
export const inject = ["harnessRoutes","harnessSessions"];

export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/extensions/records/entries', async ({ body }) => {
      const { id, value } = await body();
      return ctx.harnessSessions.records(id, { pluginId: 'records', instanceId: 'records' }).append(value, { kind: 'progress', title: 'Progress', content: 'Browser summary' });
    }));
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/extensions/records/entries', ({ url }) => ctx.harnessSessions.records(url.searchParams.get('id'), { pluginId: 'records', instanceId: 'records' }).list()));
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/extensions/records/notes', ({ url }) => ctx.harnessSessions.records(url.searchParams.get('id'), { pluginId: 'records', instanceId: 'records' }).list().map(({ data }) => data.note)));
  };
`,
  );
  const toggle = (enabled: boolean) =>
    request('/settings', 'PATCH', {
      entries: { records: { name: '../../plugins/records', disabled: !enabled } },
    });
  assert.equal((await toggle(true)).status, 200);
  const { body: session } = await request('/sessions', 'POST', {});
  await sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Persist this conversation');
  const route = '/extensions/records/entries';
  const value = { note: 'stored by the plugin' };
  const beforePluginRecords = app.runtime.plugins.ctx.harnessSessions.log(session.id).projection().leafId;
  const notes = '/extensions/records/notes?id=' + session.id;
  const added = await request(route, 'POST', { id: session.id, value });
  assert.equal(added.status, 200);
  assert.deepEqual((await request(notes)).body, [value.note]);
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await request(route + '?id=' + session.id)).status, 404);
  assert.deepEqual(
    (await request('/sessions/' + session.id)).body.timeline.filter(
      ({ type }: { type: string }) => type === 'record',
    ),
    [
      {
        id: added.body,
        plugin: 'records',
        instanceId: 'records',
        type: 'record',
        kind: 'progress',
        title: 'Progress',
        content: 'Browser summary',
      },
    ],
  );

  assert.equal((await toggle(true)).status, 200);
  const { body: entries } = await request(route + '?id=' + session.id);
  assert.deepEqual(
    entries.map(({ id, data }: { id: string; data: unknown }) => ({ id, data })),
    [{ id: added.body, data: value }],
  );
  assert.equal(activeRunCount(app.runtime.plugins.ctx), 0);
  const saved = app.runtime.plugins.ctx.harnessSessions.export([session.id])[0].log;
  assert.ok(
    saved
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some(
        (entry) =>
          entry.type === 'plugin-record' &&
          entry.owner.instanceId === 'records' &&
          entry.data.note === value.note,
      ),
  );
  const fetched = (await request('/sessions/' + session.id)).body;
  assert.equal(
    fetched.timeline.some((message: { content: unknown }) => JSON.stringify(message).includes(value.note)),
    false,
  );
  const log = app.runtime.plugins.ctx.harnessSessions.log(session.id);
  log.revise(
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'New branch' }], timestamp: Date.now() },
    },
    beforePluginRecords,
    log.projection().leafId,
  );
  assert.deepEqual((await request(notes)).body, []);
  assert.deepEqual(
    (await request('/sessions/' + session.id)).body.timeline.filter(
      ({ type }: { type: string }) => type === 'record',
    ),
    [],
  );
  assert.ok(log.entries().some(({ id }) => id === added.body));
});
