import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fixture } from '../support/api-fixture.js';

test('GUI APIs configure providers, persist keys privately, discover Skills and scope files', async (t) => {
  const { app, paths, request, mock, finish } = await fixture(t);
  const scope = '/workspaces/' + app.runtime.plugins.ctx.harnessWorkspaces.defaultId;
  const invalidChildModel = await request('/settings', 'PATCH', { pluginConfig: { subagents: { model: { provider: 'nonexistent', id: 'missing' } } } });
  assert.equal(invalidChildModel.status, 400, JSON.stringify(invalidChildModel.body));
  assert.equal((await request('/settings')).body.pluginConfig.subagents.model, null);
  writeFileSync(join(paths.cwd, 'note.md'), 'workspace note');
  mkdirSync(join(paths.home, 'skills', 'verify'), { recursive: true });
  writeFileSync(join(paths.home, 'skills', 'verify', 'SKILL.md'), '---\nname: verify\ndescription: Verify a task\n---\n\nRead the task.');
  assert.ok((await request(scope + '/skills')).body.some((s: { name: string }) => s.name === 'verify'));
  const search = await request(scope + '/files/search?q=note');
  assert.equal(search.status, 200, JSON.stringify(search.body));
  assert.ok(search.body.includes('note.md'));
  assert.equal((await request(scope + '/files/preview?path=note.md')).body.text, 'workspace note');
  assert.equal((await request(scope + '/files/preview?path=' + encodeURIComponent(paths.settings))).status, 403);
  assert.equal((await request(scope + '/files/tree?path=..')).status, 403);
  assert.equal((await request('/settings', 'PATCH', { plugins: { files: false, skills: false } })).status, 200);
  assert.equal((await request(scope + '/files/tree')).status, 404);
  assert.equal((await request(scope + '/skills')).status, 404);
  const save = await request('/providers', 'PUT', { id: 'gui-test', baseUrl: mock.url, api: 'openai-completions', models: [{ id: 'gui-model', input: ['text', 'image'] }] });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const credentials = await request('/credentials', 'POST', { provider: 'gui-test', key: 'gui-private-key' });
  assert.equal(credentials.status, 200);
  assert.doesNotMatch(JSON.stringify(credentials.body), /gui-private-key/);
  const model = { provider: 'gui-test', id: 'gui-model' };
  assert.equal((await request('/settings', 'PATCH', { pluginConfig: { 'core:models': { model } } })).status, 200);
  assert.deepEqual((await request('/models')).body.recent, model);
  assert.equal((await request('/settings/plugins/core%3Atheme', 'PATCH', { appearance: 'lavender' })).status, 400);
  assert.equal((await request('/settings/plugins/core%3Atheme', 'PATCH', { model: { provider: '', id: '' } })).status, 400);
  assert.equal((await request('/settings/plugins/files', 'PATCH', {})).status, 404);
  assert.equal((await request('/settings')).body.pluginConfig['core:theme'].appearance, 'system');
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
  const user = history.messages.find((message: { role: string; content: unknown }) => message.role === 'user');
  assert.ok(user.content.some((block: { type: string }) => block.type === 'image'));
  assert.deepEqual(user.attachments.map(({ name, mimeType }: { name: string; mimeType: string }) => ({ name, mimeType })), [
    { name: 'one.png', mimeType: 'image/png' }, { name: 'note.md', mimeType: 'text/plain' }
  ]);
  const directory = join(dirname(app.runtime.plugins.ctx.harnessRegistry.log(session.id).file), session.id, 'attachments');
  for (const [index, file] of user.attachments.entries()) {
    const data = index === 0 ? png : Buffer.from('ATTACHED CONTENT').toString('base64');
    assert.equal(readFileSync(join(directory, file.id)).toString('base64'), data);
    assert.equal(file.size, Buffer.from(data, 'base64').length);
    assert.deepEqual((await request('/sessions/' + session.id + '/attachments/' + file.id)).body, { data });
  }
  const { body: sibling } = await request('/sessions', 'POST', {});
  assert.equal((await request('/sessions/' + sibling.id + '/attachments/' + user.attachments[0].id)).status, 404);
  assert.deepEqual(user.content.filter((block: { type: string }) => block.type === 'text'), [{ type: 'text', text: 'Read the image and text' }]);
  assert.doesNotMatch(JSON.stringify(user), /ATTACHED CONTENT/);
  assert.equal(history.title, 'Read the image and text');
  assert.equal((await request('/sessions/' + session.id, 'PATCH', { title: 'Renamed task' })).body.title, 'Renamed task');
  assert.deepEqual((await request('/sessions/search?q=Read%20the%20image')).body.map(({ id }: { id: string }) => id), [session.id],
    'Content search must not depend on title');
  assert.deepEqual((await request('/sessions/search?q=unmatched-phrase')).body, []);
  assert.equal((await request('/providers', 'DELETE', { id: 'gui-test' })).status, 200);
  const afterRemoval = (await request('/settings')).body;
  assert.deepEqual(afterRemoval.pluginConfig['core:models'].model, { provider: '', id: '' });
  assert.equal((await request('/providers')).body.some((provider: { id: string }) => provider.id === 'gui-test'), false);
  assert.equal(readFileSync(join(paths.home, 'auth.json'), 'utf8').includes('gui-private-key'), false);
  const afterHistory = await request('/sessions/' + session.id);
  assert.equal(afterHistory.status, 200);
  assert.deepEqual(afterHistory.body.messages, history.messages);
  assert.equal((await request('/sessions/delete', 'POST', { ids: [session.id] })).status, 200);
  assert.equal(existsSync(dirname(directory)), false);
  assert.equal((await request('/sessions/' + session.id + '/attachments/' + user.attachments[0].id)).status, 404);
});
