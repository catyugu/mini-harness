import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import type { BrowserBootstrap } from '@mini-harness/ui-runtime/bootstrap';
import { plugins } from '@mini-harness/host/composition';
import { moduleReferences } from '../../scripts/module-references.js';
import { fixture } from '../support/api-fixture.js';

test('the composed browser graph serves its runtime dependencies and excludes server code', async (t) => {
  const { base, request } = await fixture(t);
  const { body: snapshot }: { body: BrowserBootstrap } = await request('/bootstrap');
  const mounted = new Map(snapshot.ui.map((entry) => [entry.id, entry]));
  assert.equal(mounted.size, snapshot.ui.length);
  const seenPlugins = new Set<string>();
  for (const entry of snapshot.ui) {
    for (const dependency of entry.requires ?? []) assert.ok(seenPlugins.has(dependency), entry.id + ' requires ' + dependency);
    seenPlugins.add(entry.id);
  }
  for (const { id, browser, required, defaultEnabled } of plugins)
    if (browser && (required || defaultEnabled)) assert.equal(mounted.get(id)?.browser, browser);

  for (const asset of [
    '/packages/host/src/application.js',
    '/packages/platform/src/local-secret.js',
    '/packages/input/src/prepare.js',
    '/packages/sdk/src/plugin.js',
    '/packages/settings/src/server/manager.js',
    '/packages/transport/src/router.js',
    '/packages/shell/src/server/setup.js',
    '/packages/subagents/src/server/delegation.js',
    '/packages/sessions/tests/log.test.js'
  ]) assert.equal((await fetch(base + asset)).status, 404, asset);

  const pending = ['/packages/ui-runtime/src/browser/boot.js', '/packages/ui-runtime/plugin-sdk.js'];
  for (const { browser } of plugins) if (browser) pending.push(browser);
  const seenModules = new Set<string>();
  for (const path of pending) {
    if (seenModules.has(path)) continue;
    seenModules.add(path);
    const response = await fetch(base + path);
    assert.equal(response.status, 200, 'Missing browser module: ' + path);
    const source = ts.createSourceFile(path, await response.text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const { literal, typeOnly } of moduleReferences(source)) {
      if (typeOnly) continue;
      assert.ok(literal.text.startsWith('.') || literal.text.startsWith('/'),
        'Unbundled browser import in ' + path + ': ' + literal.text);
      const target = new URL(literal.text, response.url);
      assert.equal(target.origin, base, 'Browser module has an off-origin import: ' + path);
      pending.push(target.pathname);
    }
  }

  assert.equal((await request('/settings', 'PATCH', { plugins: { files: false, shell: true } })).status, 200);
  const { body: changed }: { body: BrowserBootstrap } = await request('/bootstrap');
  assert.equal(changed.ui.some(({ id }) => id === 'files'), false);
  const dependencies = changed.ui.find(({ id }) => id === 'shell')?.requires ?? [];
  assert.ok(dependencies.includes('core:conversation'), 'Shell needs the conversation tool renderer');
  const conversation = changed.ui.find(({ id }) => id === 'core:conversation');
  assert.ok(conversation?.requires?.includes('core:approval-data'), 'Conversation needs the approval projection');
  const conversationStyle = conversation?.styles?.[0];
  assert.ok(conversationStyle);
  const sheet = await fetch(base + conversationStyle);
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get('content-type') ?? '', /^text\/css/);
  assert.match(await sheet.text(), /\.approval-heading/);
  assert.equal((await request('/settings', 'PATCH', { plugins: { shell: false } })).status, 200);
  assert.equal((await fetch(base + conversationStyle)).status, 200);
  assert.ok(changed.ui.findIndex(({ id }) => id === 'core:theme') <
    changed.ui.findIndex(({ id }) => id === 'core:primitives'));
});
