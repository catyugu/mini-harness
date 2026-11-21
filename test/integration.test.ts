import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../src/server.js';
import { createMockProvider, createFixturePaths } from './helpers/mock-provider.js';

test('real Pi SDK through HTTP: streaming, persistence, Skills, export and permanent delete', { timeout: 60000 }, async (t) => {
  const mock = await createMockProvider();
  t.after(() => mock.close());
  const { root, paths } = createFixturePaths(mock.url);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillDir = join(paths.skills, 'verification');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'),
    '---\nname: verification\ndescription: Verify the test harness on request.\n---\n\n# Verification\n\nMention the verification skill when asked.\n');

  let app = await createMiniHarnessServer(paths);
  let open = true;
  t.after(async () => { if (open) await app.close(); });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const get = (path: string) => fetch(base + path, { headers });
  const post = (path: string, payload: unknown) => fetch(base + path, {
    method: 'POST', headers, body: JSON.stringify(payload)
  });

  assert.equal((await fetch(base + '/api/bootstrap')).status, 401);
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /mini-harness/);
  const bundle = await fetch(base + '/app.js');
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /mini-harness-token/);

  const bootstrap = await (await get('/api/bootstrap')).json();
  assert.ok(bootstrap.models.some((m: {provider: string; id: string}) =>
    m.provider === 'local-mock' && m.id === 'mock-model'));

  const created = await post('/api/sessions', {});
  assert.equal(created.status, 201);
  const session = await created.json();
  const stream = await post('/api/sessions/' + session.id + '/messages', { message: 'Test SDK integration' });
  assert.equal(stream.status, 200);
  const raw = await stream.text();
  const events = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'delta'), raw);
  assert.equal(events.find((event) => event.type === 'complete')?.text, 'Mock response');
  assert.equal(events.some((event) => event.type === 'error'), false, raw);
  assert.ok(mock.requests.length > 0);

  const stored = await (await get('/api/sessions/' + session.id)).json();
  assert.equal(stored.title, 'Test SDK integration');
  assert.ok(stored.file && existsSync(stored.file));
  assert.ok(stored.messages.some((m: {role: string}) => m.role === 'assistant'));

  // Native skill command is resolved by Pi, using the configured .mini-harness skill directory.
  const skillRequest = await post('/api/sessions/' + session.id + '/messages',
    { message: '/skill:verification' });
  assert.equal(skillRequest.status, 200);
  assert.equal((await skillRequest.text()).includes('"type":"error"'), false);
  assert.ok(JSON.stringify(mock.requests.at(-1)).includes('Mention the verification skill'),
    'Pi did not expand the native SKILL.md instructions');

  await app.close();
  open = false;
  app = await createMiniHarnessServer(paths);
  open = true;
  const restored = await app.runtime.getConversation(session.id);
  assert.equal(restored.title, 'Test SDK integration');
  assert.ok(restored.messages.some((m: {role: string}) => m.role === 'assistant'));

  // Use the new server's token after restart.
  const newPort = await app.listen(0);
  const newBase = 'http://127.0.0.1:' + newPort;
  const nextHeaders = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const exported = await fetch(newBase + '/api/sessions/export', {
    method: 'POST', headers: nextHeaders, body: JSON.stringify({ ids: [session.id] })
  });
  assert.equal(exported.status, 200);
  const document = await exported.json();
  assert.equal(document.sessions[0].id, session.id);
  assert.ok(document.sessions[0].messages.length > 0);

  const deleted = await fetch(newBase + '/api/sessions/delete', {
    method: 'POST', headers: nextHeaders, body: JSON.stringify({ ids: [session.id] })
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted[0], session.id);
  assert.equal((await app.runtime.registry.list()).length, 0);
  assert.equal(existsSync(stored.file), false);
});

test('subagent tool is mounted in parent only, with an explicit concurrency limit', { timeout: 30000 }, async (t) => {
  const mock = await createMockProvider();
  t.after(() => mock.close());
  const { root, paths } = createFixturePaths(mock.url);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await createMiniHarnessServer(paths);
  t.after(() => app.close());
  const rootSession = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: rootSession.id });
  const parent = await app.runtime.open(rootSession.id);
  const worker = await app.runtime.open(child.id, { child: true });
  assert.ok(parent.getActiveToolNames().includes('delegate'));
  assert.ok(!worker.getActiveToolNames().includes('delegate'));
  assert.equal(app.runtime.semaphore.limit, 2);
});

test('concurrent opening of one conversation shares a single Pi AgentSession', { timeout: 30000 }, async (t) => {
  const mock = await createMockProvider();
  t.after(() => mock.close());
  const { root, paths } = createFixturePaths(mock.url);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await createMiniHarnessServer(paths);
  t.after(() => app.close());
  const item = app.runtime.registry.create();
  const [first, second, third] = await Promise.all([
    app.runtime.open(item.id),
    app.runtime.open(item.id),
    app.runtime.getConversation(item.id)
  ]);
  assert.strictEqual(first, second);
  assert.equal(third.id, item.id);
  assert.equal(app.runtime.openSessions.size, 1);
});
