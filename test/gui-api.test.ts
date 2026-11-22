import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMiniHarnessServer } from '../src/server.js';
import { prepareInput } from '../src/input.js';
import { Inspection } from '../src/inspection.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';

const waitUntil = async <T>(read: () => T | Promise<T>, accept: (value: T) => boolean) => {
  for (let i = 0; i < 300; i++) { const value = await read(); if (accept(value)) return value; await new Promise((done) => setTimeout(done, 10)); }
  throw new Error('Timed out waiting for operation');
};
async function fixture(t: any, reply?: Parameters<typeof createMockProvider>[0]) {
  const mock = await createMockProvider(reply), { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths), base = 'http://127.0.0.1:' + await app.listen(0);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const request = async (path: string, method = 'GET', body?: any, extra = {}) => {
    const response = await fetch(base + '/api' + path, { method, headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const finish = (id: string) => waitUntil(() => request('/sessions/' + id + '/runs'), (r) => ['completed', 'failed', 'cancelled'].includes(r.body.run?.state));
  return { mock, paths, root, app, request, finish, base };
}

test('attachments enforce encoding, format and byte limits without creating files', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  const prepared = prepareInput('', [{ name: 'one.png', mimeType: 'image/png', data: png }, { name: 'notes.md', mimeType: 'text/plain', data: Buffer.from('An attached note').toString('base64') }]);
  assert.equal(prepared.images.length, 1); assert.match(prepared.text, /An attached note/);
  assert.throws(() => prepareInput('a', [{ name: 'fake.png', mimeType: 'image/png', data: 'eA==' }]), /Invalid image/);
  assert.throws(() => prepareInput('a', [{ name: 'b', mimeType: 'text/plain', data: '!!!' }]), /Invalid attachment/);
  assert.throws(() => prepareInput('a', [{ name: 'b', mimeType: 'application/pdf', data: Buffer.from([0, 1, 2]).toString('base64') }]), /UTF-8/);
  assert.throws(() => prepareInput('a', new Array(9).fill({})), /eight/);
});

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

test('workspace registration, session navigation and scoped tools leave an active run executing', async (t) => {
  let release: () => void, entered: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const waiting = new Promise<void>((done) => { entered = done; });
  const { root, paths, app, request, finish, base } = await fixture(t, async ({ messages }) => {
    const last = messages.at(-1);
    if (last.content === 'Keep working') { entered(); await held; return 'Done'; }
    return last.role === 'tool' ? 'Written' : { tool: 'write', args: { path: 'isolated.txt', content: 'second workspace' } };
  });
  const first = '/workspaces/' + app.runtime.registry.workspaces.defaultId;
  const next = join(root, 'second');
  mkdirSync(next);
  writeFileSync(join(next, 'note.txt'), 'only in second');
  const projectSkill = join(next, '.mini-harness', 'skills', 'second-project');
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(projectSkill, 'SKILL.md'), '---\nname: second-project\ndescription: A workspace Skill\n---\n\nUse this workspace.');
  const cwd = realpathSync.native(paths.cwd);
  const { body: session } = await request(first + '/sessions', 'POST');
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Keep working' });
  try {
    await waiting;
    const { body: workspace, status } = await request('/workspaces', 'POST', { path: next });
    assert.equal(status, 201);
    const second = '/workspaces/' + workspace.id;
    const directories = await request('/workspaces/directories?path=' + encodeURIComponent(root));
    assert.ok(directories.body.directories.some(({ path }) => path === realpathSync.native(next)));
    assert.ok(!directories.body.directories.some(({ path }) => path === realpathSync.native(paths.home)));
    assert.deepEqual((await request(second + '/skills')).body.map(({ name }) => name), ['second-project']);
    assert.ok(!(await request(first + '/skills')).body.some(({ name }) => name === 'second-project'));
    const stream = await fetch(base + '/api/navigation/events', { headers: { Authorization: 'Bearer ' + app.token } });
    const events = stream.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      const snapshot = JSON.parse((await events.read()).value.trim());
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.sessions[0].id, session.id);
      const { body: other } = await request(second + '/sessions', 'POST');
      const event = JSON.parse((await events.read()).value.trim());
      assert.equal(event.type, 'session');
      assert.equal(event.session.id, other.id);
      assert.equal(other.workspaceId, workspace.id);
      assert.equal(app.runtime.registry.create({ parentId: other.id }).workspaceId, workspace.id);
      assert.throws(() => app.runtime.registry.create({ parentId: other.id, workspaceId: session.workspaceId }), /parent/);
      assert.deepEqual((await request(first + '/sessions')).body.map(({ id }) => id), [session.id]);
      assert.equal((await request(second + '/files/preview?path=note.txt&sessionId=' + session.id)).status, 404);
      const preview = await request(second + '/files/preview?path=note.txt&sessionId=' + other.id);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.content, 'only in second');
      await request('/sessions/' + other.id + '/runs', 'POST', { message: 'Write a file' });
      assert.equal((await finish(other.id)).body.run.state, 'completed');
      assert.equal(readFileSync(join(next, 'isolated.txt'), 'utf8'), 'second workspace');
      assert.equal(existsSync(join(paths.cwd, 'isolated.txt')), false);
      assert.equal((await request('/sessions/' + session.id + '/runs')).body.run.state, 'running');
      assert.equal((await request(second, 'PATCH', { name: 'Second project' })).body.name, 'Second project');
      assert.deepEqual((await request('/workspaces', 'PUT', { ids: [workspace.id, session.workspaceId] })).body.map(({ id }) => id), [workspace.id, session.workspaceId]);
      assert.equal((await request(first, 'DELETE')).status, 200);
      assert.equal((await request(first + '/files/tree')).status, 404);
      assert.ok(existsSync(paths.cwd));
      assert.equal((await request('/sessions/' + session.id + '/runs')).body.run.state, 'running');
      release();
      assert.equal((await finish(session.id)).body.run.state, 'completed');
      assert.equal((await request('/workspaces', 'POST', { path: cwd })).body.id, session.workspaceId);
      assert.equal((await request(first + '/sessions')).body[0].id, session.id);
    } finally { await events.cancel(); }
  } finally { release(); }
});

test('shell approval gates execution, handles rejection and cancellation', async (t) => {
  const { app, paths, request, finish } = await fixture(t, ({ messages }) => messages.at(-1).role === 'tool' ? 'Tool completed' :
    { tool: 'sandbox_shell', args: { command: 'echo approved' } });
  await app.runtime.updateSettings({ plugins: { shell: true }, sandbox: { mode: 'host' } });
  const { body: session } = await request('/sessions', 'POST', {});
  for (const allow of [false, true]) {
    await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Run a shell command' });
    const pending = await waitUntil(() => request('/approvals'), (r) => r.body.length > 0);
    assert.equal(pending.body[0].command, 'echo approved');
    assert.equal((await request('/approvals', 'POST', { id: pending.body[0].id, allow })).status, 200);
    await finish(session.id);
    const history = (await request('/sessions/' + session.id)).body.messages;
    const tool = history.filter((m) => m.role === 'toolResult').at(-1);
    assert.equal(tool.isError, !allow); assert.deepEqual(tool.arguments, { command: 'echo approved' });
    if (allow) assert.match(JSON.stringify(tool.content), /approved/);
  }
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Cancel pending approval' });
  await waitUntil(() => request('/approvals'), (r) => r.body.length > 0);
  await request('/sessions/' + session.id + '/cancel', 'POST', {}); await finish(session.id);
  assert.deepEqual((await request('/approvals')).body, []);
});

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

test('local plugins install disabled, load UI only when enabled, and uninstall permanently', async (t) => {
  const { paths, request } = await fixture(t);
  const route = '/extensions/gui-plugin/echo';
  const bundle = { id: 'gui-plugin', files: [
    { name: 'plugin.js', content: `export default function(ctx, api) {
      api.registerRoute('POST', '/echo', async ({ body }) => ({ echo: await body() }));
      if (api.config.fail) throw new Error('Setup failed after registering a route');
    }` },
    { name: 'web.js', content: 'export default function(api) {}' }
  ] };
  assert.equal((await request('/plugins/install', 'POST', bundle)).status, 201);
  assert.equal((await request('/plugins/gui-plugin/web')).status, 400);
  assert.equal((await request(route, 'POST', { value: 1 })).status, 404);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'gui-plugin': true } })).status, 200);
  assert.match((await request('/plugins/gui-plugin/web')).body.source, /function/);
  assert.deepEqual((await request(route, 'POST', { value: 1 })).body, { echo: { value: 1 } });
  assert.equal((await request('/settings', 'PATCH', { pluginConfig: { 'gui-plugin': { fail: true } } })).status, 400);
  assert.deepEqual((await request(route, 'POST', { value: 2 })).body, { echo: { value: 2 } });
  assert.equal((await request('/plugins/gui-plugin', 'DELETE')).status, 400);
  await request('/settings', 'PATCH', { plugins: { 'gui-plugin': false } });
  assert.equal((await request(route, 'POST', { value: 2 })).status, 404);
  assert.equal((await request('/plugins/gui-plugin', 'DELETE')).status, 200);
  assert.equal(existsSync(join(paths.plugins, 'gui-plugin')), false);
  assert.equal((await request('/plugins/install', 'POST', { ...bundle, files: [{ name: '../escape.js', content: '' }] })).status, 400);
  assert.equal((await request('/plugins/install', 'POST', { ...bundle, files: [...bundle.files, { name: 'plugin.json', content: JSON.stringify({ requires: 'invalid' }) }] })).status, 400);
  assert.equal((await request('/bootstrap')).status, 200);
  assert.equal(existsSync(join(paths.plugins, 'gui-plugin')), false);
});

test('Git inspection includes staged, unstaged and untracked files and refuses linked previews', async (t) => {
  const { paths, root } = await fixture(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: paths.cwd, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(paths.cwd, 'file.txt'), 'before\n'); git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(join(paths.cwd, 'file.txt'), 'staged\n'); git('add', '.'); writeFileSync(join(paths.cwd, 'file.txt'), 'after\n');
  writeFileSync(join(paths.cwd, 'new.txt'), 'new\n');
  const inspection = new Inspection(paths.cwd, paths.home);
  const changes = await inspection.changes(); assert.equal(changes.available, true, JSON.stringify({ reason: changes.reason, workspace: paths.cwd, repository: git('rev-parse', '--show-toplevel').trim() })); assert.equal(changes.files.length, 2);
  const alias = join(root, 'workspace-alias'); symlinkSync(paths.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await new Inspection(alias, paths.home).changes()).available, true, 'Directory aliases must resolve to the same repository root');
  const diff = await inspection.diff('file.txt'); assert.match(diff.content, /Staged/); assert.match(diff.content, /Working tree/);
  assert.match((await inspection.diff('new.txt')).content, /new/);
  await assert.rejects(inspection.preview('../home/settings.json'));
  const nestedState = join(paths.cwd, 'private'); mkdirSync(nestedState); writeFileSync(join(nestedState, 'secret.txt'), 'private contents');
  git('add', '.'); git('commit', '-qm', 'track state for denial test'); rmSync(join(nestedState, 'secret.txt'));
  await assert.rejects(new Inspection(paths.cwd, nestedState).diff('private/secret.txt')); 
  if (process.platform !== 'win32') {
    const outside = join(root, 'secret'); writeFileSync(outside, 'outside'); symlinkSync(outside, join(paths.cwd, 'link.txt'));
    await assert.rejects(inspection.preview('link.txt')); await assert.rejects(inspection.diff('link.txt'));
  }
});

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
