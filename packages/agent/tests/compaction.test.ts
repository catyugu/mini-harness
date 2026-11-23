import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../../test/support/api-fixture.js';

test('native compaction reduces context and preserves message identities and history', async (t) => {
  const { app, mock, request } = await fixture(t);
  await app.runtime.updateSettings({ pluginConfig: { 'core:agent': { autoCompact: false } } });
  const { body: session } = await request('/sessions', 'POST', {});
  const compact = () => request('/sessions/' + session.id + '/compact', 'POST');
  const small = await compact();
  assert.equal(small.status, 400);
  assert.match(small.body.error, /Nothing to compact/);
  for (let turn = 0; turn < 6; turn++) await app.runtime.runs.send(session.id, 'Turn ' + turn + ' ' + 'more context '.repeat(100));
  const before = app.runtime.agent.messages(session.id);
  const compacted = await compact();
  assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
  assert.equal(mock.requests.length, 7);
  const log = app.runtime.registry.log(session.id);
  assert.ok(log.entries().some((entry) => entry.type === 'compaction'));
  assert.deepEqual(app.runtime.agent.messages(session.id), before);
  assert.equal(log.projection().contextMessages.length, 5);
  assert.match(JSON.stringify(log.projection().contextMessages[0]), /Summary of earlier conversation/);
  assert.equal(app.runtime.hasActiveWork, false);
});
