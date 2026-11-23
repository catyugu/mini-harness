import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('queued follow-ups run within the existing native run and are consumed once', async (t) => {
  let release: () => void = () => { throw new Error('Not started'); };
  const held = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  const { mock, request, finish } = await fixture(t, async ({ messages }) => { if (messages.at(-1)?.content === 'First') await held; return 'Answer'; });
  const { body: session } = await request('/sessions', 'POST', {});
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'First' });
  await waitUntil(() => mock.requests.length, (count) => count > 0);
  const queue = await request('/sessions/' + session.id + '/queue', 'POST', { message: 'Second', mode: 'followUp' });
  assert.equal(queue.status, 202, JSON.stringify(queue.body)); assert.deepEqual(queue.body.followUp, ['Second']);
  release(); await finish(session.id);
  assert.equal(mock.requests.length, 2);
  const history = (await request('/sessions/' + session.id)).body.messages;
  assert.equal(history.filter((m: { role: string }) => m.role === 'user').length, 2);
  assert.deepEqual((await request('/sessions/' + session.id + '/queue')).body, { steer: [], followUp: [] });
});
