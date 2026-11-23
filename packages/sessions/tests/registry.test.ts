import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '../../platform/config.js';
import { SessionRegistry } from '../registry.js';
import { WorkspaceCatalog } from '../../workspaces/catalog.js';

test('nested sessions and cascading permanent deletion', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mini-harness-sessions-'));
  try {
    const paths = getPaths(realpathSync.native(temp), { MINI_HARNESS_HOME: join(temp, 'home') });
    mkdirSync(paths.sessions, { recursive: true });
    const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
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
    const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
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
    const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
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
    const restored = new SessionRegistry(paths, new WorkspaceCatalog(paths));
    assert.deepEqual(restored.list().map(({ id }) => id), [unrelated.id]);
    assert.equal(existsSync(childFile), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

