import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture } from '../../../test/support/api-fixture.ts';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';

test('conversation edits branch the native session instead of appending and enforces the active leaf', async (t) => {
  const { request, finish, app } = await fixture(
    t,
    ({ messages }) => 'Reply to ' + messages.filter((item) => item.role === 'user').at(-1)?.content,
  );
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
  const textOf = (message: any) =>
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n');
  const first = before.messages.find(
    (message: { role: string; content: unknown; id?: string }) =>
      message.role === 'user' && textOf(message) === 'Original first',
  );
  assert.ok(first?.id, 'Session Log identity must be present on persisted user messages');
  assert.ok(before.leafId, 'API must expose current branch leaf');
  const beforeProjection = app.runtime.plugins.ctx.harnessSessions.log(session.id).projection();
  const invalid = [
    { message: 'Invalid model', model: { provider: 'unknown-provider', id: 'unknown-model' } },
    {
      message: 'Image on a text model',
      attachments: [{ name: 'picture.png', mimeType: 'image/png', data: png }],
    },
    { message: '/skill:missing-skill' },
    { message: 'Unsupported reasoning', thinkingLevel: 'high' },
  ];
  for (const input of invalid) {
    const result = await request('/sessions/' + session.id + '/revise', 'POST', {
      sourceEntryId: first.id,
      expectedLeafId: beforeProjection.leafId,
      ...input,
    });
    if (result.status === 200) assert.equal((await finish(session.id)).body.run.state, 'failed');
    else assert.equal(result.status, 400, JSON.stringify(result.body));
    const unchanged = app.runtime.plugins.ctx.harnessSessions.log(session.id).projection();
    assert.equal(
      unchanged.leafId,
      beforeProjection.leafId,
      'Rejected input must not move the selected branch',
    );
    assert.deepEqual(unchanged.messages, beforeProjection.messages);
    assert.deepEqual(unchanged.model, beforeProjection.model);
    assert.equal(unchanged.thinkingLevel, beforeProjection.thinkingLevel);
  }
  const revision = await request('/sessions/' + session.id + '/revise', 'POST', {
    sourceEntryId: first.id,
    expectedLeafId: before.leafId,
    message: 'Revised first',
  });
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  const finished = await finish(session.id);
  assert.equal(finished.body.run.state, 'completed');
  const after = (await request('/sessions/' + session.id)).body;
  assert.ok(
    after.messages.some(
      (message: { role: string; content: unknown }) =>
        message.role === 'user' && textOf(message) === 'Revised first',
    ),
  );
  assert.equal(
    after.messages.some(
      (message: { role: string; content: unknown }) =>
        message.role === 'user' && textOf(message) === 'Original first',
    ),
    false,
  );
  assert.equal(
    after.messages.some(
      (message: { role: string; content: unknown }) =>
        message.role === 'user' && textOf(message) === 'Original second',
    ),
    false,
  );
  assert.notEqual(after.leafId, before.leafId);
  const exportFile = app.runtime.plugins.ctx.harnessSessions.export([session.id])[0].log;
  for (const message of ['Original first', 'Original second', 'Revised first'])
    assert.ok(exportFile.includes(message));
  assert.equal(
    (
      await request('/sessions/' + session.id + '/revise', 'POST', {
        sourceEntryId: first.id,
        expectedLeafId: before.leafId,
        message: 'Stale overwrite',
      })
    ).status,
    409,
  );
});
