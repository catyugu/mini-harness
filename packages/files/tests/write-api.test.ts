import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../../../test/support/api-fixture.js';
test('successful file writes retain arguments and this-turn paths after reopening history', async (t) => {
  const { paths, request, finish } = await fixture(t, ({ messages }) => messages.at(-1)?.role === 'tool' ? 'Written' :
    { tool: 'write', args: { path: 'result.txt', content: 'Result for inspection\n' } });
  const { body: session } = await request('/sessions', 'POST', {});
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Write a result' });
  const terminal = await finish(session.id);
  assert.equal(terminal.body.run.state, 'completed'); assert.deepEqual(terminal.body.run.changedFiles, ['result.txt']);
  assert.equal(readFileSync(join(paths.cwd, 'result.txt'), 'utf8'), 'Result for inspection\n');
  const history = (await request('/sessions/' + session.id)).body;
  assert.deepEqual(history.run.changedFiles, ['result.txt']);
  assert.deepEqual(history.messages.find((m: { toolName?: string }) => m.toolName === 'write')?.arguments, { path: 'result.txt', content: 'Result for inspection\n' });
});
