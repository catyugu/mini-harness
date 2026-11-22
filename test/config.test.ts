import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, getPaths, mergeSettings, readJson, readSettings, validateSettings, writeJson } from '../src/config.js';

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


test('legacy message-copy and edit-resend settings migrate to one session-helper switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-session-helper-'));
  try {
    const paths = getPaths(root, { MINI_HARNESS_HOME: join(root, 'home') });
    assert.equal(readSettings(paths).plugins['session-helper'], true);
    writeJson(paths.settings, {
      plugins: { 'message-copy': false, 'edit-resend': false },
      pluginConfig: { 'message-copy': { unused: 1 }, 'edit-resend': { unused: 2 } }
    });
    const disabled = readSettings(paths);
    assert.equal(disabled.plugins['session-helper'], false);
    for (const legacy of ['message-copy', 'edit-resend']) {
      assert.equal(Object.hasOwn(disabled.plugins, legacy), false);
      assert.equal(Object.hasOwn(disabled.pluginConfig, legacy), false);
    }
    assert.deepEqual(readJson<any>(paths.settings, {}).plugins, disabled.plugins,
      'migration is persisted and the old switches cannot return after restart');

    writeJson(paths.settings, { plugins: { 'message-copy': false, 'edit-resend': true } });
    const enabled = readSettings(paths);
    assert.equal(enabled.plugins['session-helper'], true);
    assert.throws(() => mergeSettings(enabled, { plugins: { 'edit-resend': false } }),
      /configured through session-helper/);
    assert.throws(() => mergeSettings(enabled, { pluginConfig: { 'message-copy': {} } }),
      /configured through session-helper/);
    assert.equal(mergeSettings(enabled, { plugins: { 'session-helper': false } }).plugins['session-helper'], false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
