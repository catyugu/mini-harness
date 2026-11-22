import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMiniHarnessServer } from '../../../src/server.js';
import { prepareInput } from '../../../src/input.js';
import { Inspection } from '../inspection.js';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('successful file writes retain arguments and this-turn paths after reopening history', async (t) => {
  const { paths, request, finish } = await fixture(t, ({ messages }) => messages.at(-1).role === 'tool' ? 'Written' :
    { tool: 'write', args: { path: 'result.txt', content: 'Result for inspection\n' } });
  const { body: session } = await request('/sessions', 'POST', {});
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Write a result' });
  const terminal = await finish(session.id);
  assert.equal(terminal.body.run.state, 'completed'); assert.deepEqual(terminal.body.run.changedFiles, ['result.txt']);
  assert.equal(readFileSync(join(paths.cwd, 'result.txt'), 'utf8'), 'Result for inspection\n');
  const history = (await request('/sessions/' + session.id)).body;
  assert.deepEqual(history.run.changedFiles, ['result.txt']);
  assert.deepEqual(history.messages.find((m) => m.toolName === 'write').arguments, { path: 'result.txt', content: 'Result for inspection\n' });
});
