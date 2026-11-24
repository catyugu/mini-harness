import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '@mini-harness/platform/paths';
import { loadCatalog } from '../catalog.js';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';

function fixture(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mini-harness-catalog-')));
  const paths = getPaths(root, { MINI_HARNESS_HOME: join(root, 'home') });
  const workspaces = new WorkspaceCatalog(paths);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { paths, workspaces };
}

const record = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', workspaceId, parentId: null,
  title: 'Conversation', titleSource: 'manual', createdAt: '2026-01-01T00:00:00.000Z', ...overrides
});

test('an absent catalog is an empty conversation index', (t) => {
  const { paths, workspaces } = fixture(t);
  assert.deepEqual(loadCatalog(paths, workspaces), { sessions: [] });
});

test('catalog startup rejects records that cannot resolve a workspace or ancestry', (t) => {
  const { paths, workspaces } = fixture(t);
  const workspace = workspaces.defaultId;
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
  const { paths, workspaces } = fixture(t);
  const workspace = workspaces.defaultId;
  const session = record(workspace);
  const pendingDelete = [{ id: session.id, workspaceId: workspace }];
  writeFileSync(paths.registry, JSON.stringify({ sessions: [], pendingDelete }));
  assert.deepEqual(loadCatalog(paths, workspaces), { sessions: [], pendingDelete });
  writeFileSync(paths.registry, JSON.stringify({ sessions: [], pendingDelete: { id: session.id } }));
  assert.throws(() => loadCatalog(paths, workspaces), /Invalid deletion journal/);
});
