import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCapabilities } from '@mini-harness/kernel/composition';
import { PluginCatalog } from '@mini-harness/plugins/catalog';
import { PluginHost } from '@mini-harness/plugins/manager';
import { Context } from 'cordis';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import type { SessionRecord } from '@mini-harness/contracts/conversation';
import { DEFAULTS, mergeSettings, validateSettings } from '@mini-harness/platform/config';

declare module '../../packages/contracts/plugin-sdk.js' {
  interface ServiceMap {
    greeting: string;
    extra: string;
  }
}

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
        required: true, provides: ['greeting'] },
      { id: 'local', title: 'Local', description: '', scope: 'workspace', provides: ['greeting'] }
    ], ['harnessRoutes']);
    const key = 'workspace:' + 'a'.repeat(32);
    const settings = mergeSettings(DEFAULTS as any, {
      scopes: { [key]: { plugins: { local: true }, providers: { greeting: 'local' } } }
    });
    validateSettings(settings);
    const descriptors = catalog.descriptors();
    descriptors.push({ id: 'fake-locked', title: 'Fake', description: '', scope: 'workspace', provides: ['harnessRoutes'] });
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
      inheritedIds, { plugins: { 'fake-locked': true }, providers: { harnessRoutes: 'fake-locked' } }),
    /Protected service/);
    assert.throws(() => validateSettings({ ...settings, scopes: {
      [key]: { providers: { greeting: '../outside' } }
    } }), /Invalid provider selection/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('reusing a provider ID in a descendant still requires explicit shadowing', () => {
  const inherited = new Map([['greeting', 'local']]);
  const descriptor = [{ id: 'local', provides: ['greeting'] }];
  assert.throws(() => resolveCapabilities(descriptor, inherited), /Multiple enabled providers/);
  assert.equal(resolveCapabilities(descriptor, inherited, { greeting: 'local' }).providers.get('greeting'), 'local');
  assert.throws(() => resolveCapabilities(descriptor, inherited, { greeting: 'local' }, undefined,
    new Set(['greeting'])), /Protected service/);
});

test('live scoped providers isolate siblings, restore inheritance and roll back failed setup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-live-scopes-'));
  const workspaceId = 'a'.repeat(32);
  const records = new Map<string, SessionRecord>([
    ['parent', { id: 'parent', workspaceId, parentId: null } as SessionRecord],
    ['child', { id: 'child', workspaceId, parentId: 'parent' } as SessionRecord],
    ['sibling', { id: 'sibling', workspaceId, parentId: null } as SessionRecord]
  ]);
  const released: string[] = [];
  const builtins: PluginDescriptor[] = [
    { id: 'global', scope: 'application', title: 'Global', description: '', required: true,
      provides: ['greeting', 'extra'], setup(_ctx, api) { api.provide('greeting', 'global'); api.provide('extra', 'retained'); } },
    { id: 'workspace', scope: 'workspace', title: 'Workspace', description: '', provides: ['greeting'],
      setup(_ctx, api) { api.provide('greeting', 'workspace'); } },
    { id: 'layer', scope: 'session', title: 'Layer', description: '', provides: ['greeting'],
      setup(_ctx, api) {
        api.onDispose(() => { released.push(String(api.config.value)); });
        if (api.config.fail) throw new Error('Scoped setup failed');
        api.provide('greeting', String(api.config.value));
      } }
  ];
  let settings = structuredClone(DEFAULTS);
  const ctx = new Context();
  ctx.provide('authority', {});
  const host = new PluginHost(ctx, directory, builtins, ['authority'], () => settings,
    (id) => records.get(id), () => ({ list: () => [], append: async () => '' }));
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await host.start(settings);
  const configure = (scopes) => {
    const next = { ...settings, scopes };
    return host.configure(next, () => { settings = next; });
  };
  const parent = { plugins: { layer: true }, providers: { greeting: 'layer' }, pluginConfig: { layer: { value: 'parent' } } };
  const child = { plugins: { layer: true }, providers: { greeting: 'layer' }, pluginConfig: { layer: { value: 'child' } } };
  await configure({ 'session:parent': parent, 'session:child': child });
  await Promise.all([host.prepare('child'), host.prepare('sibling')]);
  assert.equal(host.require('parent', 'greeting'), 'parent');
  assert.equal(host.require('child', 'greeting'), 'child');
  assert.equal(host.require('sibling', 'greeting'), 'global');
  assert.equal(host.require('child', 'extra'), 'retained');
  await assert.rejects(configure({ ...settings.scopes, 'session:parent': {
    ...parent, pluginConfig: { layer: { value: 'broken', fail: true } }
  } }), /Scoped setup failed/);
  assert.equal(host.require('child', 'greeting'), 'child');
  assert.equal(host.require('parent', 'greeting'), 'parent');
  assert.ok(released.includes('broken'));

  // Keep the scope alive for policy but remove its service; a stale isolate must not mask the parent.
  await configure({ 'session:parent': parent, 'session:child': { disabledTools: ['shell'] } });
  assert.equal(host.require('child', 'greeting'), 'parent');
  assert.equal(host.allowsTool('child', 'shell'), false);

  // Adding a configured ancestor of an already mounted child must mount that ancestor immediately.
  await configure({ ['workspace:' + workspaceId]: { plugins: { workspace: true }, providers: { greeting: 'workspace' } },
    'session:child': { disabledTools: ['shell'] } });
  assert.equal(host.require('child', 'greeting'), 'workspace');
  assert.equal(host.require('sibling', 'greeting'), 'workspace');
  assert.equal(ctx.get('greeting'), 'global');
  await configure({});
  assert.equal(host.require('child', 'greeting'), 'global');
});
