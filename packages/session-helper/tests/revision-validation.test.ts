import { expectPresent } from '../../../test/support/required.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../../../test/support/api-fixture.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';

test('rejected revision input never changes the selected conversation branch', async (t) => {
  const { request, finish, app } = await fixture(t);
  const session = app.runtime.registry.create();
  await app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Original first');
  await app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Original second');
  const before = app.runtime.registry.log(session.id).projection();
  const source = before.messages.find((message) => message.role === 'user');
  const invalid = [
    { message: 'Invalid model', model: { provider: 'unknown-provider', id: 'unknown-model' } },
    { message: 'Image on a text model', attachments: [{ name: 'picture.png', mimeType: 'image/png', data: png }] },
    { message: '/skill:missing-skill' },
    { message: 'Unsupported reasoning', thinkingLevel: 'high' }
  ];
  for (const input of invalid) {
    const result = await request('/extensions/session-helper/revise', 'POST', {
      sessionId: session.id, sourceEntryId: expectPresent(source, 'source user message').id, expectedLeafId: before.leafId, ...input
    });
    if (result.status === 200) assert.equal((await finish(session.id)).body.run.state, 'failed');
    else assert.equal(result.status, 400, JSON.stringify(result.body));
    const after = app.runtime.registry.log(session.id).projection();
    assert.equal(after.leafId, before.leafId, 'Rejected input must not move the selected branch');
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.model, before.model);
    assert.equal(after.thinkingLevel, before.thinkingLevel);
  }
});
