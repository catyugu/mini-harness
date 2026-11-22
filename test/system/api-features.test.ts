import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMiniHarnessServer } from '../../src/server.js';
import { prepareInput } from '../../src/input.js';
import { Inspection } from '../../features/files/inspection.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

import { fixture, waitUntil } from '../../support/api-fixture.js';

test('GUI APIs configure providers, persist keys privately, discover Skills and scope files', async (t) => {
  const { app, paths, request, mock, finish } = await fixture(t);
  const scope = '/workspaces/' + app.runtime.registry.workspaces.defaultId;
  writeFileSync(join(paths.cwd, 'note.md'), 'workspace note');
  mkdirSync(join(paths.skills, 'verify'));
  writeFileSync(join(paths.skills, 'verify', 'SKILL.md'), '---\nname: verify\ndescription: Verify a task\n---\n\nRead the task.');
  assert.ok((await request(scope + '/skills')).body.some((s) => s.name === 'verify'));
  const search = await request(scope + '/files/search?q=note');
  assert.equal(search.status, 200, JSON.stringify(search.body));
  assert.ok(search.body.includes('note.md'));
  assert.equal((await request(scope + '/files/preview?path=note.md')).body.content, 'workspace note');
  assert.equal((await request(scope + '/files/preview?path=' + encodeURIComponent(paths.settings))).status, 400);
  assert.equal((await request(scope + '/files/tree?path=..')).status, 400);
  assert.equal((await request('/settings', 'PATCH', { plugins: { files: false, skills: false } })).status, 200);
  assert.equal((await request(scope + '/files/tree')).status, 404);
  assert.equal((await request(scope + '/skills')).status, 404);
  const save = await request('/providers', 'PUT', { id: 'gui-test', baseUrl: mock.url, api: 'openai-completions', models: [{ id: 'gui-model', input: ['text', 'image'] }] });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal((await request('/credentials', 'POST', { provider: 'gui-test', key: 'gui-private-key' })).status, 200);
  assert.equal((await request('/settings', 'PATCH', { model: { provider: 'gui-test', id: 'gui-model' } })).status, 200);
  const bootstrap = await request('/bootstrap'); assert.equal(JSON.stringify(bootstrap.body).includes('gui-private-key'), false);
  assert.ok(readFileSync(join(paths.home, 'auth.json'), 'utf8').includes('gui-private-key'));
  const { body: session } = await request('/sessions', 'POST', {});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  assert.equal((await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Read the image and text', attachments: [
    { name: 'one.png', mimeType: 'image/png', data: png }, { name: 'note.md', mimeType: 'text/plain', data: Buffer.from('ATTACHED CONTENT').toString('base64') }
  ] })).status, 202);
  assert.equal((await finish(session.id)).body.run.state, 'completed');
  assert.match(JSON.stringify(mock.requests.at(-1)), /ATTACHED CONTENT/); assert.match(JSON.stringify(mock.requests.at(-1)), /image_url/);
  const history = (await request('/sessions/' + session.id)).body;
  assert.ok(history.messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'image')));
  assert.equal((await request('/sessions/' + session.id, 'PATCH', { title: 'Renamed task' })).body.title, 'Renamed task');
  assert.equal((await request('/providers', 'DELETE', { id: 'gui-test' })).status, 200);
  const afterRemoval = (await request('/bootstrap')).body;
  assert.deepEqual(afterRemoval.settings.model, { provider: '', id: '' });
  assert.equal(afterRemoval.providers.some((provider) => provider.id === 'gui-test'), false);
  assert.equal(readFileSync(join(paths.home, 'auth.json'), 'utf8').includes('gui-private-key'), false);
  const afterHistory = await request('/sessions/' + session.id);
  assert.equal(afterHistory.status, 200);
  assert.deepEqual(afterHistory.body.messages, history.messages);
});
