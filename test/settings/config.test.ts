import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, mergeSettings, readSettings, validateSettings } from '@mini-harness/settings/config';
import { getPaths } from '@mini-harness/platform/paths';

test('config directories are independent and default safe', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-harness-config-'));
  try {
    const paths = getPaths(folder, { MINI_HARNESS_HOME: join(folder, 'home') });
    assert.ok(paths.sessions.startsWith(paths.home));
    assert.deepEqual(readSettings(paths).plugins, {});
    assert.deepEqual(readSettings(paths).pluginConfig, {});
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('settings merge preserves other sections and validates bounds', () => {
  const before = structuredClone(DEFAULTS) as import('@mini-harness/settings/api').Settings;
  before.plugins.example = true;
  const after = mergeSettings(before, { plugins: { shell: true }, pluginConfig: { subagents: { maxParallel: 4 } } });
  assert.equal(after.plugins.example, true);
  assert.equal(after.plugins.shell, true);
  assert.equal(after.pluginConfig.subagents.maxParallel, 4);
  assert.equal(before.plugins.shell, undefined);
  assert.throws(() => mergeSettings(before, { queueMode: 'steer' }), /Unknown settings field/);
  assert.throws(() => mergeSettings(before, { model: { provider: 'example' } }), /Unknown settings field/);
  assert.throws(() => validateSettings({ ...before, pluginConfig: { shell: null } }), /Invalid plugin configuration/);
  assert.throws(() => mergeSettings(before, { sandbox: { mode: 'host' } }), /Unknown settings field/);
  assert.throws(() => mergeSettings(before, { bogus: true }), /Unknown/);
  assert.throws(() => validateSettings({ ...before, plugins: { shell: 'true' } }), /boolean/);
});
