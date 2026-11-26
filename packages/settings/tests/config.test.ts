import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeSettings, validateSettings } from '@mini-harness/plugin-api/selection';

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
  assert.throws(
    () => validateSettings({ ...before, entries: { shell: { config: null } } }),
    /Invalid plugin configuration/,
  );
  assert.throws(() => mergeSettings(before, { bogus: true }), /Unknown/);
  assert.throws(() => validateSettings({ ...before, entries: { shell: { disabled: 'true' } } }), /boolean/);
});
