import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '../src/config.js';
import { SessionRegistry } from '../src/services/conversations.js';

test('nested sessions and cascading permanent deletion', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-sessions-'));
  try {
    const paths = getPaths(realpathSync.native(temp), { MINI_HARNESS_HOME: join(temp, 'home') });
    mkdirSync(paths.sessions, { recursive: true });
    const registry = new SessionRegistry(paths);
    const parent = registry.create({ title: 'root' });
    const child = registry.create({ title: 'worker', parentId: parent.id });
    const second = registry.create({ title: 'unrelated' });
    const file = join(paths.sessions, child.id + '.jsonl');
    writeFileSync(file, 'hello');
    registry.update(child.id, { file });
    assert.equal(registry.list().length, 3);
    assert.deepEqual(new Set(registry.descendants([parent.id])), new Set([parent.id, child.id]));
    const deleted = registry.delete([parent.id]);
    assert.equal(deleted.length, 2);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0].id, second.id);
    assert.equal(existsSync(file), false);
    assert.throws(() => registry.delete(['does-not-exist']), /Unknown conversation/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('refuses deletion of files outside managed session directory', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-safe-'));
  try {
    const paths = getPaths(temp, { MINI_HARNESS_HOME: join(temp, 'home') });
    const registry = new SessionRegistry(paths);
    const item = registry.create();
    const foreign = join(temp, 'other.jsonl');
    writeFileSync(foreign, 'keep');
    registry.update(item.id, { file: foreign });
    assert.throws(() => registry.delete([item.id]), /outside managed storage/);
    assert.equal(existsSync(foreign), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('restarts finish a journaled deletion after partial cleanup', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-recovery-'));
  try {
    const paths = getPaths(realpathSync.native(temp), { MINI_HARNESS_HOME: join(temp, 'home') });
    mkdirSync(paths.sessions, { recursive: true });
    const registry = new SessionRegistry(paths);
    const parent = registry.create();
    const child = registry.create({ parentId: parent.id });
    const unrelated = registry.create();
    const parentFile = join(paths.sessions, parent.id + '.jsonl');
    const childFile = join(paths.sessions, child.id + '.jsonl');
    writeFileSync(childFile, 'child history');
    writeFileSync(paths.registry, JSON.stringify({
      sessions: [unrelated],
      pendingDelete: [{ ...parent, file: parentFile }, { ...child, file: childFile }]
    }));
    const restored = new SessionRegistry(paths);
    assert.deepEqual(restored.list().map(({ id }) => id), [unrelated.id]);
    assert.equal(existsSync(childFile), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('legacy workspace and session indexes migrate without moving Pi history or re-registering a removed workspace', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-migrate-'));
  try {
    const first = getPaths(temp, { MINI_HARNESS_HOME: join(temp, 'home') });
    const second = getPaths(join(temp, 'second'), { MINI_HARNESS_HOME: first.home });
    mkdirSync(first.sessions, { recursive: true });
    mkdirSync(second.sessions, { recursive: true });
    mkdirSync(second.cwd);
    const file = join(second.sessions, 'old.jsonl');
    writeFileSync(file, 'old Pi history');
    writeFileSync(join(first.home, 'workspaces.json'), JSON.stringify([second.cwd]));
    writeFileSync(first.registry, JSON.stringify({ sessions: [{
      id: 'legacy', parentId: null, cwd: second.cwd, title: 'Old session', file,
      createdAt: '2026-01-01', updatedAt: '2026-01-01'
    }] }));
    const registry = new SessionRegistry(first);
    const migrated = registry.get('legacy');
    assert.equal(migrated.workspaceId, registry.workspaces.list().find(({ path }) => path === realpathSync.native(second.cwd)).id);
    assert.equal(JSON.parse(readFileSync(first.registry, 'utf8')).sessions[0].workspaceId, migrated.workspaceId);
    assert.equal(registry.export(['legacy'])[0].piSession, 'old Pi history');
    registry.workspaces.remove(migrated.workspaceId);
    const restored = new SessionRegistry(first);
    assert.ok(!restored.workspaces.list().some(({ id }) => id === migrated.workspaceId));
    assert.equal(restored.get('legacy').file, file);
    assert.equal(restored.workspaces.register(second.cwd).id, migrated.workspaceId);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
