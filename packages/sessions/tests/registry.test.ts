import { isViewMessage } from '../src/shared/message.ts';
import { nativeFile } from '../src/storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '@mini-harness/platform/paths';
import { loadCatalog } from '../src/catalog.ts';
import { SessionRegistry } from '../src/registry.ts';

function fixture(t: test.TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-sessions-'));
  const paths = getPaths(realpathSync.native(temp), { MINI_HARNESS_HOME: join(temp, 'home') });
  mkdirSync(paths.home, { recursive: true });
  const registry = new SessionRegistry(paths);
  t.after(() => {
    registry.dispose();
    rmSync(temp, { recursive: true, force: true });
  });
  return { temp, paths, registry };
}

test('nested sessions cascade permanent deletion through native logs', async (t) => {
  const { paths, registry } = fixture(t);
  const parent = registry.create({ title: 'root' });
  const child = registry.create({ title: 'worker', parentId: parent.id });
  assert.equal(child.workspaceId, null);
  assert.equal(registry.workspacePath(parent.id), undefined);
  const second = registry.create({ title: 'unrelated' });
  const log = registry.log(child.id);
  log.append({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() },
  });
  const file = nativeFile(paths, child);
  assert.equal(registry.list().length, 3);
  assert.deepEqual(new Set(registry.descendants([parent.id])), new Set([parent.id, child.id]));
  const deleted = await registry.delete([parent.id]);
  assert.equal(deleted.length, 2);
  assert.deepEqual(
    registry.list().map(({ id }) => id),
    [second.id],
  );
  assert.equal(existsSync(file), false);
  assert.throws(() => log.append({ type: 'branch' }), /closed/);
  await assert.rejects(registry.delete(['does-not-exist']), /Unknown conversation/);
});

test('refuses export and deletion through a symlink outside managed storage', async (t) => {
  const { temp, paths, registry } = fixture(t);
  const item = registry.create();
  const foreign = join(temp, 'other.jsonl');
  writeFileSync(foreign, 'keep');
  registry.log(item.id);
  const file = nativeFile(paths, item);
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
  registry.log(child.id);
  const childFile = nativeFile(paths, child);
  const upload = {
    name: 'document.pdf',
    mimeType: 'application/pdf',
    data: Buffer.from([0, 1, 2]).toString('base64'),
  };
  const prepared = registry.prepareInput(child.id, '', [upload]);
  const fileId = prepared.input.attachments[0].id;
  assert.ok(fileId);
  const directory = registry.attachmentDirectory(child.id);
  assert.ok(directory);
  assert.equal(registry.readAttachment(child.id, fileId)?.toString('base64'), upload.data);
  registry.dispose();
  writeFileSync(
    paths.registry,
    JSON.stringify({
      sessions: [unrelated],
      pendingDelete: [
        { id: parent.id, workspaceId: parent.workspaceId },
        { id: child.id, workspaceId: child.workspaceId },
      ],
    }),
  );
  const forgotten: string[] = [];
  const restored = new SessionRegistry(paths, undefined, undefined, async (keys) => {
    forgotten.push(...keys);
  });
  t.after(() => restored.dispose());
  await restored.recoverDeletion();
  assert.deepEqual(
    restored.list().map(({ id }) => id),
    [unrelated.id],
  );
  assert.equal(existsSync(childFile), false);
  assert.equal(existsSync(directory), false);
  assert.deepEqual(new Set(forgotten), new Set(['session:' + parent.id, 'session:' + child.id]));
});

test('export includes all branches and rejects in-flight sessions', (t) => {
  const { registry } = fixture(t);
  const session = registry.create();
  const log = registry.log(session.id);
  const data = Buffer.from([0, 1, 2]).toString('base64');
  const prepared = registry.prepareInput(session.id, 'original', [
    { name: 'document.pdf', mimeType: 'application/pdf', data },
  ]);
  const first = log.append({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: prepared.text }], timestamp: Date.now() },
    presentation: prepared.input,
  });
  log.revise(
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'revision' }], timestamp: Date.now() },
    },
    null,
    first.id,
  );
  const [exported] = registry.export([session.id]);
  assert.ok(exported.log.includes(first.id));
  assert.deepEqual(exported.attachments, { [prepared.input.attachments[0].id]: data });
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
  registry.log(damaged.id);
  const invalid = nativeFile(paths, damaged);
  registry.log(healthy.id).append({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'intact' }], timestamp: Date.now() },
  });
  registry.dispose();
  appendFileSync(invalid, '{"checksum":"bad"}\n');
  const restored = new SessionRegistry(paths);
  t.after(() => restored.dispose());
  assert.equal(restored.list().length, 3);
  assert.equal(
    restored.inspectLog(unopened.id, (log) => log.entries()),
    undefined,
  );
  assert.equal(existsSync(nativeFile(paths, unopened, false)), false);
  assert.deepEqual(restored.log(healthy.id).projection().timeline.filter(isViewMessage)[0].content, [
    { type: 'text', text: 'intact' },
  ]);
  assert.throws(() => restored.log(damaged.id), /session diagnostics/);
  assert.deepEqual(restored.diagnostics(), [{ id: damaged.id, message: 'Corrupt session log checksum' }]);
  assert.deepEqual(await restored.delete([damaged.id]), [damaged.id]);
  assert.equal(existsSync(invalid), false);
  assert.deepEqual(restored.diagnostics(), []);
});

const record = (workspaceId: string | null, overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId,
  parentId: null,
  title: 'Conversation',
  titleSource: 'manual',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('catalog startup rejects duplicate identities and invalid ancestry', (t) => {
  const { paths, registry } = fixture(t);
  registry.dispose();
  const workspace = null;
  writeFileSync(paths.registry, JSON.stringify({ sessions: [record(workspace), record(workspace)] }));
  assert.throws(() => loadCatalog(paths), /Invalid conversation index/);
  writeFileSync(
    paths.registry,
    JSON.stringify({
      sessions: [
        record(workspace, {
          id: '22222222-2222-4222-8222-222222222222',
          parentId: '33333333-3333-4333-8333-333333333333',
        }),
      ],
    }),
  );
  assert.throws(() => loadCatalog(paths), /Invalid conversation ancestry/);
});

test('a valid catalog keeps the deletion journal and rejects a partial one', (t) => {
  const { paths, registry } = fixture(t);
  registry.dispose();
  const workspace = null;
  const session = record(workspace);
  const pendingDelete = [{ id: session.id, workspaceId: workspace }];
  writeFileSync(paths.registry, JSON.stringify({ sessions: [], pendingDelete }));
  assert.deepEqual(loadCatalog(paths), { sessions: [], pendingDelete });
  writeFileSync(paths.registry, JSON.stringify({ sessions: [], pendingDelete: { id: session.id } }));
  assert.throws(() => loadCatalog(paths), /Invalid deletion journal/);
});

test('public session logs expose record operations but not the writer lifecycle', (t) => {
  const { registry } = fixture(t);
  const session = registry.create();
  const log = registry.log(session.id);
  assert.equal('close' in log, false);
  assert.equal('file' in log, false);
  registry.inspectLog(session.id, (view) => {
    assert.equal('close' in view, false);
    assert.equal('file' in view, false);
  });
  log.append({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'Still writable' }], timestamp: 1 },
  });
  assert.deepEqual(registry.history(session.id).timeline.filter(isViewMessage)[0].content, [
    { type: 'text', text: 'Still writable' },
  ]);
});
