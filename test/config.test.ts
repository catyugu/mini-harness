import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, getPaths, mergeSettings, readSettings, validateSettings, writeJson } from '../src/config.js';

test('config directories are independent and default safe', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-harness-config-'));
  try {
    const paths = getPaths(folder, { MINI_HARNESS_HOME: join(folder, 'home') });
    assert.ok(paths.sessions.startsWith(paths.home));
    assert.ok(paths.projectSkills.endsWith(join('.mini-harness', 'skills')));
    assert.equal(readSettings(paths).plugins.shell, false);
    assert.equal(readSettings(paths).sandbox.mode, 'isolated');
    writeJson(paths.settings, { appearance: 'dark' });
    assert.equal(readSettings(paths).appearance, 'dark');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('settings merge preserves other sections and validates bounds', () => {
  const before = structuredClone(DEFAULTS) as unknown as import('../src/config.js').Settings;
  const after = mergeSettings(before, { plugins: { shell: true }, subagents: { maxParallel: 4 } });
  assert.equal(after.plugins.skills, true);
  assert.equal(after.plugins.shell, true);
  assert.equal(after.subagents.maxParallel, 4);
  assert.equal(before.plugins.shell, false);
  assert.throws(() => mergeSettings(before, { subagents: { maxParallel: 0 } }), /maxParallel/);
  assert.throws(() => mergeSettings(before, { sandbox: { mode: 'unknown' as any } }), /sandbox/);
  assert.throws(() => mergeSettings(before, { bogus: true } as any), /Unknown/);
  assert.throws(() => validateSettings({ ...before, plugins: { shell: 'true' } }), /boolean/);
});
