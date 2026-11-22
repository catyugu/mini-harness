import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMiniHarnessServer } from '../../../src/server.js';
import { prepareInput } from '../../../src/input.js';
import { Inspection } from '../../files/inspection.js';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('queued follow-ups run within the existing Pi run and are consumed once', async (t) => {
  let release: () => void;
  const held = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  const { mock, request, finish } = await fixture(t, async ({ messages }) => { if (messages.at(-1).content === 'First') await held; return 'Answer'; });
  const { body: session } = await request('/sessions', 'POST', {});
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'First' });
  await waitUntil(() => mock.requests.length, (count) => count > 0);
  const queue = await request('/sessions/' + session.id + '/queue', 'POST', { message: 'Second', mode: 'followUp' });
  assert.equal(queue.status, 202, JSON.stringify(queue.body)); assert.deepEqual(queue.body.followUp, ['Second']);
  release(); await finish(session.id);
  assert.equal(mock.requests.length, 2);
  const history = (await request('/sessions/' + session.id)).body.messages;
  assert.equal(history.filter((m) => m.role === 'user').length, 2);
  assert.deepEqual((await request('/sessions/' + session.id + '/queue')).body, { steer: [], followUp: [] });
});
