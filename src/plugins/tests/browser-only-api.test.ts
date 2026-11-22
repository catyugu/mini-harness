import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMiniHarnessServer } from '../../server.js';
import { prepareInput } from '../../input.js';
import { Inspection } from '../../../features/files/inspection.js';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('web-only plugins install and unload without a dummy backend entry', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/plugins/install', 'POST', {
    id: 'browser-only', files: [{ name: 'web.js', content: 'export default api => api.command({name:"browser-only",description:"Test"});' }]
  })).status, 201);
  assert.equal((await request('/plugins/browser-only/web')).status, 400);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'browser-only': true } })).status, 200);
  assert.match((await request('/plugins/browser-only/web')).body.source, /browser-only/);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'browser-only': false } })).status, 200);
  assert.equal((await request('/plugins/browser-only/web')).status, 400);
  assert.equal((await request('/plugins/browser-only', 'DELETE')).status, 200);
  const settings = (await request('/bootstrap')).body.settings;
  assert.equal(settings.plugins['browser-only'], undefined);
  assert.equal(settings.pluginConfig['browser-only'], undefined);
});
