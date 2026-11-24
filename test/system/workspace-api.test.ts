import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../support/api-fixture.js';

test('workspace registration, session navigation and scoped tools leave an active run executing', async (t) => {
  let release: () => void = () => { throw new Error('Not started'); };
  let entered: () => void = () => { throw new Error('Not started'); };
  const held = new Promise<void>((done) => { release = done; });
  const waiting = new Promise<void>((done) => { entered = done; });
  const { root, paths, app, request, finish, base } = await fixture(t, async ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
    if (last.content === 'Keep working') { entered(); await held; return 'Done'; }
    return last.role === 'tool' ? 'Written' : { tool: 'write', args: { path: 'isolated.txt', content: 'second workspace' } };
  });
  const first = '/workspaces/' + app.runtime.plugins.ctx.harnessWorkspaces.defaultId;
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
    assert.ok(directories.body.directories.some(({ path }: { path: string }) => path === realpathSync.native(next)));
    assert.ok(!directories.body.directories.some(({ path }: { path: string }) => path === realpathSync.native(paths.home)));
    assert.ok(!(await request(first + '/skills')).body.some(({ name }: { name: string }) => name === 'second-project'));
    const stream = await fetch(base + '/api/changes', { headers: { Authorization: 'Bearer ' + app.token } });
    const events = expectPresent(stream.body, 'workspace event stream').pipeThrough(new TextDecoderStream()).getReader();
    try {
      const snapshot = JSON.parse(expectPresent((await events.read()).value, 'initial stream event').trim());
      assert.equal(snapshot.type, 'snapshot');
      assert.ok(Number.isInteger(snapshot.revisions.sessions));
      const { body: other } = await request(second + '/sessions', 'POST');
      const event = JSON.parse(expectPresent((await events.read()).value, 'next stream event').trim());
      assert.equal(event.type, 'change');
      assert.equal(event.domain, 'sessions');
      assert.ok(event.revision > snapshot.revisions.sessions);
      assert.equal(event.sessionId, other.id);
      assert.equal(other.workspaceId, workspace.id);
      assert.equal(app.runtime.registry.create({ parentId: other.id }).workspaceId, workspace.id);
      assert.throws(() => app.runtime.registry.create({ parentId: other.id, workspaceId: session.workspaceId }), /parent/);
      assert.deepEqual((await request(first + '/sessions')).body.map(({ id }: { id: string }) => id), [session.id]);
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
      assert.deepEqual((await request('/workspaces', 'PUT', { ids: [workspace.id, session.workspaceId] })).body.map(({ id }: { id: string }) => id), [workspace.id, session.workspaceId]);
      release();
      assert.equal((await finish(session.id)).body.run.state, 'completed');
      const removal = await request(first, 'DELETE');
      assert.equal(removal.status, 200);
      assert.ok(removal.body.deleted.includes(session.id));
      assert.equal((await request(first + '/files/tree')).status, 404);
      assert.equal((await request('/sessions/' + session.id)).status, 404);
      assert.ok(existsSync(paths.cwd), 'Delete never removes user workspace files');
      assert.equal((await request('/workspaces', 'POST', { path: cwd })).body.id, session.workspaceId);
      assert.deepEqual((await request(first + '/sessions')).body, []);
    } finally { await events.cancel(); }
  } finally { release(); }
});
