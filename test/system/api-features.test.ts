import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { fixture, waitUntil } from '../support/api-fixture.ts';

test('GUI APIs configure providers, persist keys privately, discover Skills and scope files', async (t) => {
  const { app, paths, request, mock, finish } = await fixture(t);
  const scope = '/workspaces/' + app.runtime.plugins.ctx.harnessWorkspaces.defaultId;
  const invalidChildModel = await request('/settings', 'PATCH', {
    entries: { subagents: { config: { model: { provider: 'nonexistent', id: 'missing' } } } },
  });
  assert.equal(invalidChildModel.status, 400, JSON.stringify(invalidChildModel.body));
  assert.equal((await request('/settings')).body.entries.subagents?.config?.model, undefined);
  writeFileSync(join(paths.cwd, 'note.md'), 'workspace note');
  mkdirSync(join(paths.home, 'skills', 'verify'), { recursive: true });
  writeFileSync(
    join(paths.home, 'skills', 'verify', 'SKILL.md'),
    '---\nname: verify\ndescription: Verify a task\n---\n\nRead the task.',
  );
  assert.ok((await request(scope + '/skills')).body.some((s: { name: string }) => s.name === 'verify'));
  const search = await request(scope + '/files/search?q=note');
  assert.equal(search.status, 200, JSON.stringify(search.body));
  assert.ok(search.body.includes('note.md'));
  assert.equal((await request(scope + '/files/preview?path=note.md')).body.text, 'workspace note');
  assert.equal(
    (
      await request(
        scope +
          '/files/preview?path=' +
          encodeURIComponent(join(paths.home, 'profiles', 'web', 'cordis.patch.yml')),
      )
    ).status,
    403,
  );
  assert.equal((await request(scope + '/files/tree?path=..')).status, 403);
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { files: { disabled: true }, skills: { disabled: true } },
      })
    ).status,
    200,
  );
  assert.equal((await request(scope + '/files/tree')).status, 404);
  assert.equal((await request(scope + '/skills')).status, 404);
  const connection = { id: 'gui-test', baseUrl: mock.url, api: 'openai-completions' };
  const discovery = await request('/providers/discovery', 'POST', { ...connection, key: 'gui-private-key' });
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  assert.deepEqual(
    discovery.body.map(({ id }: { id: string }) => id),
    ['mock-model', 'discovered-model'],
  );
  assert.equal(discovery.body[1].contextWindow, 65536);
  assert.equal(
    (
      await request('/providers/discovery', 'POST', {
        ...connection,
        baseUrl: mock.url + '/missing',
      })
    ).status,
    503,
  );
  assert.equal(
    (await request('/providers')).body.some(({ id }: { id: string }) => id === connection.id),
    false,
  );
  const created = await request('/providers', 'PUT', {
    ...connection,
    create: true,
    name: 'GUI provider',
    key: 'gui-private-key',
    models: [],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const providers = await request('/providers');
  assert.doesNotMatch(JSON.stringify(providers.body), /gui-private-key/);
  assert.deepEqual(providers.body.find(({ id }: { id: string }) => id === connection.id).models, []);
  const save = await request('/providers', 'PUT', {
    ...connection,
    name: 'Edited GUI provider',
    models: [{ id: 'gui-model', input: ['text', 'image'] }],
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const model = { provider: 'gui-test', id: 'gui-model' };
  assert.equal(
    (await request('/settings', 'PATCH', { entries: { 'core:models': { config: { model } } } })).status,
    200,
  );
  assert.deepEqual((await request('/models')).body.recent, model);
  assert.equal(
    (await request('/settings/plugins/core%3Atheme', 'PATCH', { appearance: 'lavender' })).status,
    400,
  );
  assert.equal(
    (await request('/settings/plugins/core%3Atheme', 'PATCH', { model: { provider: '', id: '' } })).status,
    400,
  );
  assert.equal((await request('/settings/plugins/files', 'PATCH', {})).status, 404);
  assert.equal(
    (await request('/bootstrap')).body.ui.find(({ id }: { id: string }) => id === 'core:theme')?.config
      .appearance,
    'system',
  );
  const bootstrap = await request('/bootstrap');
  assert.equal(JSON.stringify(bootstrap.body).includes('gui-private-key'), false);
  assert.ok(readFileSync(join(paths.home, 'auth.json'), 'utf8').includes('gui-private-key'));
  const { body: session } = await request('/sessions', 'POST', {});
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  assert.equal(
    (
      await request('/sessions/' + session.id + '/runs', 'POST', {
        message: 'Read the image and text',
        attachments: [
          { name: 'one.png', mimeType: 'image/png', data: png },
          {
            name: 'note.md',
            mimeType: 'text/plain',
            data: Buffer.from('ATTACHED CONTENT').toString('base64'),
          },
        ],
      })
    ).status,
    202,
  );
  assert.equal((await finish(session.id)).body.run.state, 'completed');
  assert.match(JSON.stringify(mock.requests.at(-1)), /ATTACHED CONTENT/);
  assert.match(JSON.stringify(mock.requests.at(-1)), /image_url/);
  const history = (await request('/sessions/' + session.id)).body;
  const user = history.timeline.find(
    (message: { role: string; content: unknown }) => message.role === 'user',
  );
  assert.equal(user.attachments[0].data, png);
  assert.deepEqual(
    user.attachments.map(({ name, mimeType }: { name: string; mimeType: string }) => ({ name, mimeType })),
    [
      { name: 'one.png', mimeType: 'image/png' },
      { name: 'note.md', mimeType: 'text/plain' },
    ],
  );
  const directory = app.runtime.plugins.ctx.harnessSessions.attachmentDirectory(session.id);
  assert.ok(directory);
  for (const [index, file] of user.attachments.entries()) {
    const data = index === 0 ? png : Buffer.from('ATTACHED CONTENT').toString('base64');
    assert.equal(readFileSync(join(directory, file.id)).toString('base64'), data);
    assert.equal(file.size, Buffer.from(data, 'base64').length);
    assert.deepEqual((await request('/sessions/' + session.id + '/attachments/' + file.id)).body, { data });
  }
  const { body: sibling } = await request('/sessions', 'POST', {});
  assert.equal(
    (await request('/sessions/' + sibling.id + '/attachments/' + user.attachments[0].id)).status,
    404,
  );
  assert.equal(user.content, 'Read the image and text');
  assert.doesNotMatch(JSON.stringify(user), /ATTACHED CONTENT/);
  assert.equal(history.title, 'Read the image and text');
  assert.equal(
    (await request('/sessions/' + session.id, 'PATCH', { title: 'Renamed task' })).body.title,
    'Renamed task',
  );
  assert.deepEqual(
    (await request('/sessions/search?q=Read%20the%20image')).body.map(({ id }: { id: string }) => id),
    [session.id],
    'Content search must not depend on title',
  );
  assert.deepEqual((await request('/sessions/search?q=unmatched-phrase')).body, []);
  const ctx = app.runtime.plugins.ctx;
  const failObserver = ctx.on(
    'models/catalog-changed',
    () => {
      throw new Error('Broken catalog observer');
    },
    { prepend: true },
  );
  try {
    assert.equal((await request('/providers', 'DELETE', { id: 'gui-test' })).status, 200);
  } finally {
    failObserver();
  }
  assert.deepEqual((await request('/models')).body.recent, { provider: '', id: '' });
  await waitUntil(
    () => request('/settings'),
    ({ body }) => body.entries['core:models']?.config?.model?.provider === '',
  );
  assert.equal(
    (await request('/providers')).body.some((provider: { id: string }) => provider.id === 'gui-test'),
    false,
  );
  assert.equal(readFileSync(join(paths.home, 'auth.json'), 'utf8').includes('gui-private-key'), false);
  const afterHistory = await request('/sessions/' + session.id);
  assert.equal(afterHistory.status, 200);
  assert.deepEqual(afterHistory.body.timeline, history.timeline);
  assert.equal((await request('/sessions/delete', 'POST', { ids: [session.id] })).status, 200);
  assert.equal(existsSync(dirname(directory)), false);
  assert.equal(
    (await request('/sessions/' + session.id + '/attachments/' + user.attachments[0].id)).status,
    404,
  );
});

test('a trusted gateway can forward plugin routes without an additional host allowlist', async (t) => {
  const { app } = await fixture(t);
  const ctx = app.runtime.plugins.ctx;
  const release = ctx.harnessRoutes.register('POST', '/api/extension/ping', async ({ body }) => ({
    received: await body(),
  }));
  const signal = new AbortController();
  let origin = '';
  const gateway = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer gateway-token') {
      res.writeHead(401).end();
      return;
    }
    void ctx.harnessNetwork.forward(req, res, { origin, signal: signal.signal });
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port;
  t.after(async () => {
    signal.abort();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await release();
  });
  const send = (path: string, headers: Record<string, string> = {}) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ value: 42 }),
    });
  assert.equal((await send('/api/extension/ping')).status, 401);
  const headers = { authorization: 'Bearer gateway-token' };
  const result = await send('/api/extension/ping', headers);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { received: { value: 42 } });
  assert.equal(
    (await send('/api/extension/ping', { ...headers, origin: 'https://example.invalid' })).status,
    403,
  );
  assert.equal((await send('/api/shutdown', headers)).status, 403);
});

test('unbound conversations can run, persist attachments and be deleted without workspace tools', async (t) => {
  const { request, finish } = await fixture(t);
  const { body: session, status } = await request('/sessions', 'POST', { workspaceId: null });
  assert.equal(status, 201);
  assert.equal(session.workspaceId, null);
  const data = Buffer.from('workspace-free attachment').toString('base64');
  const started = await request('/sessions/' + session.id + '/runs', 'POST', {
    message: 'Read attachment',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data }],
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await finish(session.id)).body.run.state, 'completed');
  const { body: history } = await request('/sessions/' + session.id);
  const id = history.timeline.find((message: { role: string }) => message.role === 'user').attachments[0].id;
  assert.deepEqual((await request('/sessions/' + session.id + '/attachments/' + id)).body, { data });
  assert.equal((await request('/sessions/delete', 'POST', { ids: [session.id] })).status, 200);
});
