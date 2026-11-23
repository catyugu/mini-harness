import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, getPaths, mergeSettings, readSettings, validateSettings, writeJson } from '../../packages/platform/config.js';

test('config directories are independent and default safe', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-harness-config-'));
  try {
    const paths = getPaths(folder, { MINI_HARNESS_HOME: join(folder, 'home') });
    assert.ok(paths.sessions.startsWith(paths.home));
    assert.ok(paths.projectSkills.endsWith(join('.mini-harness', 'skills')));
    assert.deepEqual(readSettings(paths).plugins, {});
    assert.deepEqual(readSettings(paths).pluginConfig, {});
    writeJson(paths.settings, { appearance: 'dark' });
    assert.equal(readSettings(paths).appearance, 'dark');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('settings merge preserves other sections and validates bounds', () => {
  const before = structuredClone(DEFAULTS) as import('../../packages/contracts/config.js').Settings;
  before.plugins.example = true;
  const after = mergeSettings(before, { plugins: { shell: true }, pluginConfig: { subagents: { maxParallel: 4 } } });
  assert.equal(after.plugins.example, true);
  assert.equal(after.plugins.shell, true);
  assert.equal(after.pluginConfig.subagents.maxParallel, 4);
  assert.equal(before.plugins.shell, undefined);
  assert.throws(() => validateSettings({ ...before, pluginConfig: { shell: null } }), /Invalid plugin configuration/);
  assert.throws(() => mergeSettings(before, { sandbox: { mode: 'host' } } as any), /Unknown settings field/);
  assert.throws(() => mergeSettings(before, { bogus: true } as any), /Unknown/);
  assert.throws(() => validateSettings({ ...before, plugins: { shell: 'true' } }), /boolean/);
});


test('plugin names are not reserved for removed built-ins and never trigger rewrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-config-names-'));
  try {
    const paths = getPaths(root, { MINI_HARNESS_HOME: join(root, 'home') });
    writeJson(paths.settings, { plugins: { 'message-copy': true, 'edit-resend': false },
      pluginConfig: { 'message-copy': { label: 'local' } } });
    const settings = readSettings(paths);
    assert.equal(settings.plugins['message-copy'], true);
    assert.equal(settings.plugins['edit-resend'], false);
    assert.deepEqual(settings.pluginConfig['message-copy'], { label: 'local' });
    assert.equal(mergeSettings(settings, { plugins: { 'edit-resend': true } }).plugins['edit-resend'], true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
