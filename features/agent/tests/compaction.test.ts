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

test('manual compaction uses Pi and preserves an idle conversation on failure', async (t) => {
  const { app, mock, request } = await fixture(t);
  const { body: session } = await request('/sessions', 'POST', {});
  const compact = () => request('/sessions/' + session.id + '/compact', 'POST');
  const small = await compact();
  assert.equal(small.status, 400);
  assert.match(small.body.error, /Nothing to compact/);
  const pi = await app.runtime.pi.open(session.id);
  pi.settingsManager.setCompactionEnabled(false);
  for (let turn = 0; turn < 6; turn++) await app.runtime.runs.send(session.id, 'Turn ' + turn + ' ' + 'more context '.repeat(1550));
  const compacted = await compact();
  assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
  assert.equal(mock.requests.length, 7);
  assert.ok(pi.sessionManager.getEntries().some((entry) => entry.type === 'compaction'));
  assert.equal(app.runtime.hasActiveWork, false);
});
