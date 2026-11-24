import { nativeFile } from '../src/storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '@mini-harness/platform/paths';
import { loadCatalog } from '../src/catalog.js';
import { SessionRegistry } from '../src/registry.js';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';

function fixture(t: test.TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-sessions-'));
  const paths = getPaths(realpathSync.native(temp), { MINI_HARNESS_HOME: join(temp, 'home') });
  const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  t.after(() => { registry.dispose(); rmSync(temp, { recursive: true, force: true }); });
  return { temp, paths, registry };
}

test('nested sessions cascade permanent deletion through native logs', async (t) => {
  const { registry } = fixture(t);
  const parent = registry.create({ title: 'root' });
  const child = registry.create({ title: 'worker', parentId: parent.id });
  const second = registry.create({ title: 'unrelated' });
  const log = registry.log(child.id);
  log.append({ type: 'message', message: { role: 'user', content: 'hello', timestamp: Date.now() } });
  const file = log.file;
  assert.equal(registry.list().length, 3);
  assert.deepEqual(new Set(registry.descendants([parent.id])), new Set([parent.id, child.id]));
  const deleted = await registry.delete([parent.id]);
  assert.equal(deleted.length, 2);
  assert.deepEqual(registry.list().map(({ id }) => id), [second.id]);
  assert.equal(existsSync(file), false);
  assert.throws(() => log.append({ type: 'branch' }), /closed/);
  await assert.rejects(registry.delete(['does-not-exist']), /Unknown conversation/);
});

test('refuses export and deletion through a symlink outside managed storage', async (t) => {
  const { temp, registry } = fixture(t);
  const item = registry.create();
  const foreign = join(temp, 'other.jsonl');
  writeFileSync(foreign, 'keep');
  const file = registry.log(item.id).file;
  rmSync(file);
  symlinkSync(foreign, file);
  assert.throws(() => registry.export([item.id]), /outside managed storage/);
  await assert.rejects(registry.delete([item.id]), /outside managed storage/);
  assert.equal(existsSync(foreign), true);
  assert.ok(registry.get(item.id));
});

test('restart finishes a journaled deletion after partial cleanup', async (t) => {
  const { paths, registry } = fixture(t);
  const parent = registry.create();
  const child = registry.create({ parentId: parent.id });
  const unrelated = registry.create();
  const childFile = registry.log(child.id).file;
  registry.dispose();
  writeFileSync(paths.registry, JSON.stringify({ sessions: [unrelated],
    pendingDelete: [{ id: parent.id, workspaceId: parent.workspaceId }, { id: child.id, workspaceId: child.workspaceId }] }));
  const forgotten: string[] = [];
  const restored = new SessionRegistry(paths, new WorkspaceCatalog(paths), undefined, undefined, async (keys) => { forgotten.push(...keys); });
  t.after(() => restored.dispose());
  await restored.recoverDeletion();
  assert.deepEqual(restored.list().map(({ id }) => id), [unrelated.id]);
  assert.equal(existsSync(childFile), false);
  assert.deepEqual(new Set(forgotten), new Set(['session:' + parent.id, 'session:' + child.id]));
});

test('export includes all branches and rejects in-flight sessions', (t) => {
  const { registry } = fixture(t);
  const session = registry.create();
  const log = registry.log(session.id);
  const first = log.append({ type: 'message', message: { role: 'user', content: 'original', timestamp: Date.now() } });
  log.revise({ type: 'message', message: { role: 'user', content: 'revision', timestamp: Date.now() } }, null, first.id);
  const [exported] = registry.export([session.id]);
  assert.ok(exported.log.includes(first.id));
  assert.ok(exported.log.includes('original') && exported.log.includes('revision'));
  const release = registry.beforeDelete({ quiesce: async () => {}, busy: () => true });
  assert.throws(() => registry.export([session.id]), /Stop active/);
  release();
});

test('a corrupt log is isolated, remains deletable and never creates a log for an unopened session', async (t) => {
  const { paths, registry } = fixture(t);
  const damaged = registry.create({ title: 'Damaged' });
  const healthy = registry.create({ title: 'Healthy' });
  const unopened = registry.create();
  const invalid = registry.log(damaged.id).file;
  registry.log(healthy.id).append({ type: 'message', message: { role: 'user', content: 'intact', timestamp: Date.now() } });
  registry.dispose();
  appendFileSync(invalid, '{"checksum":"bad"}\n');
  const restored = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  t.after(() => restored.dispose());
  assert.equal(restored.list().length, 3);
  assert.equal(restored.inspectLog(unopened.id, (log) => log.entries()), undefined);
  assert.equal(existsSync(nativeFile(paths, new WorkspaceCatalog(paths), unopened, false)), false);
  assert.equal(restored.log(healthy.id).projection().messages[0].content, 'intact');
  assert.throws(() => restored.log(damaged.id), /session diagnostics/);
  assert.deepEqual(restored.diagnostics(), [{ id: damaged.id, message: 'Corrupt session log checksum' }]);
  assert.deepEqual(await restored.delete([damaged.id]), [damaged.id]);
  assert.equal(existsSync(invalid), false);
  assert.deepEqual(restored.diagnostics(), []);
});

const record = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', workspaceId, parentId: null,
  title: 'Conversation', titleSource: 'manual', createdAt: '2026-01-01T00:00:00.000Z', ...overrides
});

test('catalog startup rejects records that cannot resolve a workspace or ancestry', (t) => {
  const { paths, registry } = fixture(t);
  const workspaces = new WorkspaceCatalog(paths);
  registry.dispose();
  const workspace = workspaces.defaultId;
  assert.ok(workspace);
  writeFileSync(paths.registry, JSON.stringify({ sessions: [record('f'.repeat(32))] }));
  assert.throws(() => loadCatalog(paths, workspaces), /Workspace not found/);
  writeFileSync(paths.registry, JSON.stringify({ sessions: [record(workspace), record(workspace)] }));
  assert.throws(() => loadCatalog(paths, workspaces), /Invalid conversation index/);
  writeFileSync(paths.registry, JSON.stringify({ sessions: [record(workspace, {
    id: '22222222-2222-4222-8222-222222222222', parentId: '33333333-3333-4333-8333-333333333333'
  })] }));
  assert.throws(() => loadCatalog(paths, workspaces), /Invalid conversation ancestry/);
});

test('a valid catalog keeps the deletion journal and rejects a partial one', (t) => {
  const { paths, registry } = fixture(t);
  const workspaces = new WorkspaceCatalog(paths);
  registry.dispose();
  const workspace = workspaces.defaultId;
  assert.ok(workspace);
  const session = record(workspace);
  const pendingDelete = [{ id: session.id, workspaceId: workspace }];
  writeFileSync(paths.registry, JSON.stringify({ sessions: [], pendingDelete }));
  assert.deepEqual(loadCatalog(paths, workspaces), { sessions: [], pendingDelete });
  writeFileSync(paths.registry, JSON.stringify({ sessions: [], pendingDelete: { id: session.id } }));
  assert.throws(() => loadCatalog(paths, workspaces), /Invalid deletion journal/);
});
