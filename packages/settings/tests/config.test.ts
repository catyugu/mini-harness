import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, mergeSettings, validateSettings } from '@mini-harness/plugin-api/selection';
import { getPaths } from '@mini-harness/platform/paths';

test('config directories are independent and default safe', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-harness-config-'));
  try {
    const paths = getPaths(folder, { MINI_HARNESS_HOME: join(folder, 'home') });
    assert.ok(paths.sessions.startsWith(paths.home));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('settings merge preserves other sections and validates bounds', () => {
  const before = structuredClone(DEFAULTS);
  before.entries.example = { disabled: false };
  const after = mergeSettings(before, {
    entries: { shell: { disabled: false }, subagents: { config: { maxParallel: 4 } } },
  });
  assert.equal(after.entries.example?.disabled, false);
  assert.equal(after.entries.shell?.disabled, false);
  assert.equal(after.entries.subagents?.config?.maxParallel, 4);
  assert.equal(before.entries.shell, undefined);
  assert.throws(() => mergeSettings(before, { queueMode: 'steer' }), /Unknown settings field/);
  assert.throws(() => mergeSettings(before, { model: { provider: 'example' } }), /Unknown settings field/);
  assert.throws(
    () => validateSettings({ ...before, entries: { shell: { config: null } } }),
    /Invalid plugin configuration/,
  );
  assert.throws(() => mergeSettings(before, { sandbox: { mode: 'host' } }), /Unknown settings field/);
  assert.throws(() => mergeSettings(before, { bogus: true }), /Unknown/);
  assert.throws(() => mergeSettings(before, { plugins: {} }), /Unknown/);
  assert.throws(() => mergeSettings(before, { pluginConfig: {} }), /Unknown/);
  assert.throws(() => validateSettings({ ...before, entries: { shell: { disabled: 'true' } } }), /boolean/);
});
