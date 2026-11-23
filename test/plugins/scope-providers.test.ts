import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCapabilities } from '../../packages/kernel/composition.js';
import { PluginCatalog } from '../../packages/plugins/catalog.js';
import { DEFAULTS, mergeSettings, validateSettings } from '../../packages/platform/config.js';

test('explicit scoped provider choice shadows inherited service only in the child graph', () => {
  const parent = new Map([['greeting', 'global'], ['harnessRoutes', 'application']]);
  const plugins = [
    { id: 'consumer', inject: ['greeting'] },
    { id: 'local', provides: ['greeting'] }
  ];
  assert.throws(() => resolveCapabilities(plugins, parent), /Multiple enabled providers/);
  const child = resolveCapabilities(plugins, parent, { greeting: 'local' });
  assert.equal(child.providers.get('greeting'), 'local');
  assert.equal(child.ordered[0].descriptor.id, 'local');
  assert.equal(child.ordered.find((item) => item.descriptor.id === 'consumer')?.services.greeting, 'local');
  assert.equal(parent.get('greeting'), 'global');
  assert.equal(resolveCapabilities([{ id: 'consumer', inject: ['greeting'] }], parent)
    .ordered[0].services.greeting, 'global');
  assert.throws(() => resolveCapabilities(
    [{ id: 'fake', provides: ['harnessRoutes'] }], parent, { harnessRoutes: 'fake' },
    undefined, new Set(['harnessRoutes'])), /Protected service/);
  assert.throws(() => resolveCapabilities(
    [{ id: 'consumer', inject: ['greeting'] }], parent, { greeting: 'missing' }
  ), /Selected provider/);
});

test('catalog computes independent scoped provider maps and rejects fixed service shadows', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-scope-providers-'));
  try {
    const catalog = new PluginCatalog(folder, [
      { id: 'global', title: 'Global', description: '', scope: 'application',
        required: true, replaceable: true, provides: ['greeting'] },
      { id: 'local', title: 'Local', description: '', scope: 'workspace', provides: ['greeting'] },
      { id: 'locked', title: 'Locked', description: '', scope: 'application',
        required: true, provides: ['protectedCapability'] },
      { id: 'fake-locked', title: 'Fake', description: '', scope: 'workspace',
        provides: ['protectedCapability'] }
    ], ['harnessRoutes']);
    const key = 'workspace:' + 'a'.repeat(32);
    const settings = mergeSettings(DEFAULTS as any, {
      scopes: { [key]: { plugins: { local: true }, providers: { greeting: 'local' } } }
    });
    validateSettings(settings);
    const descriptors = catalog.descriptors();
    const app = catalog.plans(settings, descriptors, 'application',
      new Map([['harnessRoutes', 'application']]), new Set());
    assert.equal(app.providers.get('greeting'), 'global');
    const inheritedIds = new Set(app.plans.map(({ id }) => id));
    const workspace = catalog.plans(settings, descriptors, 'workspace', app.providers,
      inheritedIds, settings.scopes[key]);
    assert.equal(workspace.providers.get('greeting'), 'local');
    assert.equal(app.providers.get('greeting'), 'global');
    assert.equal(catalog.plans(settings, descriptors, 'workspace', app.providers,
      inheritedIds).providers.get('greeting'), 'global');
    assert.throws(() => catalog.plans(settings, descriptors, 'workspace', app.providers,
      inheritedIds, { plugins: { 'fake-locked': true }, providers: { protectedCapability: 'fake-locked' } }),
    /Protected service/);
    assert.throws(() => validateSettings({ ...settings, scopes: {
      [key]: { providers: { greeting: '../outside' } }
    } }), /Invalid provider selection/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
