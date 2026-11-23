import test from 'node:test';
import assert from 'node:assert/strict';


import { fixture } from '../../../test/support/api-fixture.js';
test('session-helper edits branch the Pi session instead of appending and enforces the active leaf', async (t) => {
  const { request, finish, app } = await fixture(t, ({ messages }) => 'Reply to ' + messages.filter((item) => item.role === 'user').at(-1)?.content);
  const pluginIds = (await request('/bootstrap')).body.plugins.map((plugin) => plugin.id);
  assert.equal(pluginIds.filter((id) => id === 'session-helper').length, 1);
  assert.equal(pluginIds.includes('message-copy') || pluginIds.includes('edit-resend'), false);
  const session = (await request('/sessions', 'POST', {})).body;
  const send = async (message: string) => {
    const started = await request('/sessions/' + session.id + '/runs', 'POST', { message });
    assert.equal(started.status, 202);
    const done = await finish(session.id);
    assert.equal(done.body.run.state, 'completed');
  };
  await send('Original first');
  await send('Original second');
  const before = (await request('/sessions/' + session.id)).body;
  const textOf = (message: any) => typeof message.content === 'string' ? message.content :
    message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  const first = before.messages.find((message) => message.role === 'user' && textOf(message) === 'Original first');
  assert.ok(first?.id, 'Pi entry identity must be present on persisted user messages');
  assert.ok(before.leafId, 'API must expose current branch leaf');
  const revision = await request('/extensions/session-helper/revise', 'POST', {
    sessionId: session.id, sourceEntryId: first.id, expectedLeafId: before.leafId, message: 'Revised first'
  });
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  const finished = await finish(session.id);
  assert.equal(finished.body.run.state, 'completed');
  const after = (await request('/sessions/' + session.id)).body;
  assert.ok(after.messages.some((message) => message.role === 'user' && textOf(message) === 'Revised first'));
  assert.equal(after.messages.some((message) => message.role === 'user' && textOf(message) === 'Original first'), false);
  assert.equal(after.messages.some((message) => message.role === 'user' && textOf(message) === 'Original second'), false);
  assert.notEqual(after.leafId, before.leafId);
  const exportFile = app.runtime.export([session.id])[0].piSession;
  for (const message of ['Original first', 'Original second', 'Revised first']) assert.ok(exportFile.includes(message));
  assert.equal((await request('/extensions/session-helper/revise', 'POST', {
    sessionId: session.id, sourceEntryId: first.id, expectedLeafId: before.leafId, message: 'Stale overwrite'
  })).status, 409);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'session-helper': false } })).status, 200);
  assert.equal((await request('/extensions/session-helper/revise', 'POST', {
    sessionId: session.id, sourceEntryId: first.id, expectedLeafId: after.leafId, message: 'Disabled'
  })).status, 404);
});
