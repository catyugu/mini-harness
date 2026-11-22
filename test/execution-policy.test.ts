import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../src/server.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';
import { sandboxCommand, supportsIsolation } from '../src/sandbox.js';

async function fixture(t: any) {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths), runtime = app.runtime;
  const base = 'http://127.0.0.1:' + await app.listen(0);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const tool = (id: string, name: string) => runtime.plugins.getTools(id).find((tool) => tool.name === name);
  return { root, paths, runtime, tool, request };
}

test('permission is enforced on cached tools and inherited by descendants', async (t) => {
  const { runtime, paths, tool } = await fixture(t);
  const parent = runtime.registry.create();
  const write = tool(parent.id, 'write');
  await write.execute('one', { path: 'allowed.txt', content: 'allowed' }, undefined, undefined, undefined);
  runtime.setPermission(parent.id, 'read-only', false);
  await assert.rejects(write.execute('two', { path: 'denied.txt', content: 'denied' }, undefined, undefined, undefined), /Read-only/);
  assert.equal(existsSync(join(paths.cwd, 'denied.txt')), false);
  const child = runtime.registry.create({ parentId: parent.id });
  assert.equal(child.permission, 'read-only');
  assert.throws(() => runtime.setPermission(child.id, 'full', true), /parent/);
  // Even malformed persisted child grants cannot expand the ancestor's permission.
  runtime.registry.update(child.id, { permission: 'full' });
  await assert.rejects(tool(child.id, 'write').execute('three', { path: 'child.txt', content: 'denied' }, undefined, undefined, undefined), /Read-only/);
  assert.throws(() => runtime.setPermission(parent.id, 'full', false), /confirmation/);
  runtime.setPermission(parent.id, 'full', true);
  await assert.rejects(tool(parent.id, 'write').execute('four', { path: '../outside.txt', content: 'denied' }, undefined, undefined, undefined), /permitted workspace/);
});

test('trusted plugin tools cannot claim read capability to bypass the execution gate', async (t) => {
  const { runtime, paths, tool } = await fixture(t);
  const folder = join(paths.plugins, 'trust-check'); mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), `export default (ctx, api) => {
    api.registerTool({ name: 'trust_check', description: 'Fixture', parameters: {type: 'object', properties: {}},
      execute: async () => ({content: [{type: 'text', text: 'ran'}]}) }, {capabilities: ['read']});
  };`);
  await runtime.updateSettings({ plugins: { 'trust-check': true } });
  const item = runtime.registry.create({ permission: 'read-only' });
  const installed = tool(item.id, 'trust_check');
  await assert.rejects(installed.execute('one', {}, undefined, undefined, undefined), /full permission/);
  runtime.setPermission(item.id, 'full', true);
  assert.match(JSON.stringify(await installed.execute('two', {}, undefined, undefined, undefined)), /ran/);
});

test('restricted Shell uses read-only mounts and never falls back to host mode', async (t) => {
  const { runtime, paths, tool, request } = await fixture(t);
  await runtime.updateSettings({ plugins: { shell: true }, sandbox: { mode: 'host' } });
  const item = runtime.registry.create({ permission: 'read-only' });
  const args = sandboxCommand('touch forbidden.txt', paths.cwd, 'isolated', 'linux', 60, false).args;
  const at = args.indexOf(paths.cwd);
  assert.equal(args[at - 1], '--ro-bind');
  const pending = tool(item.id, 'sandbox_shell').execute('shell', { command: 'echo changed > forbidden.txt' }, undefined, undefined, undefined);
  const checked = supportsIsolation() ? pending.then((result) => assert.match(JSON.stringify(result), /Read-only|read-only|Permission denied/)) : assert.rejects(pending, /Isolation unavailable/);
  const approvals = await request('/approvals');
  assert.equal(approvals.length, 1);
  await request('/approvals', { id: approvals[0].id, allow: true });
  await checked;
  assert.equal(existsSync(join(paths.cwd, 'forbidden.txt')), false);
});


test('default permission only affects future sessions and todo state survives reopening without crossing sessions', async (t) => {
  const { runtime } = await fixture(t);
  const first = runtime.createConversation();
  runtime.registry.update(first.id, { permission: undefined }); // Existing records predate explicit session permissions.
  await runtime.updateSettings({ defaultPermission: 'read-only' });
  const second = runtime.createConversation();
  assert.equal(runtime.permission(first.id), 'workspace-write');
  assert.equal(runtime.navigationSession(first.id).permission, 'workspace-write');
  assert.equal((await runtime.getConversation(first.id)).permission, 'workspace-write');
  assert.equal(runtime.permission(second.id), 'read-only');
  await assert.rejects(runtime.updateSettings({ defaultPermission: 'full' }), /confirmation/);
  await runtime.send(first.id, 'Track tasks');
  const items = [{ id: 'one', text: 'Verify task', state: 'in-progress' as const }];
  await runtime.setTodos(first.id, items);
  assert.deepEqual(await runtime.getTodos(second.id), []);
  const session = await runtime.open(first.id);
  session.dispose(); runtime.openSessions.delete(first.id);
  assert.deepEqual(await runtime.getTodos(first.id), items);
  await assert.rejects(runtime.setTodos(first.id, [...items, ...items]), /Invalid task/);
});
