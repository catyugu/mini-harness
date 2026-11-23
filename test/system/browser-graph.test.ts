import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { plugins } from '@mini-harness/host/composition';
import { fixture } from '../support/api-fixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('the composed browser graph is derived from the mounted capability descriptors', async (t) => {
  const { request } = await fixture(t);
  const { body } = await request('/bootstrap');
  const mounted = new Map<string, { browser?: string }>(body.ui.map((entry: { id: string; browser?: string }) => [entry.id, entry]));
  assert.equal(mounted.size, body.ui.length);
  assert.deepEqual(Object.keys(body), ['ui']);
  for (const id of ['core:models-data', 'core:plugins-data', 'core:approvals-data'])
    assert.equal(mounted.has(id), false, 'Retired proxy plugin remains mounted: ' + id);
  assert.ok(mounted.has('core:settings-data'), 'Theme requires an independent settings projection');
  for (const id of ['core:settings', 'core:models', 'core:plugins', 'core:approvals'])
    assert.ok(mounted.has(id), 'Domain plugin is missing: ' + id);
  const browser = new Map(plugins.filter(({ browser }) => browser).map((plugin) => [plugin.id, plugin]));
  for (const entry of plugins.filter(({ browser }) => browser)) {
    if (!entry.browser) throw new Error('Browser entry missing for ' + entry.id);
    assert.match(entry.browser, /^\/packages\/[a-z-]+(?:\/[a-z-]+)*\.js$/);
    const source = resolve(root, entry.browser.slice(1).replace(/\.js$/, '.ts'));
    assert.ok(existsSync(source), 'Missing browser entry: ' + entry.browser);
    const ast = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.some((statement) => ts.isExportAssignment(statement) && !statement.isExportEquals),
      'Missing default browser plugin export: ' + entry.browser);
    for (const required of entry.browserRequires ?? []) assert.ok(browser.has(required));
    const dependencies = new Set(entry.browserRequires ?? []);
    for (const dependency of dependencies)
      for (const transitive of browser.get(dependency)?.browserRequires ?? []) dependencies.add(transitive);
    const code = ast.getFullText();
    if (/api\.(?:insert|command|completion|beginDraftMode|cancelDraftMode)\(/.test(code))
      assert.ok(dependencies.has('core:conversation'), entry.id + ' must declare the composer provider');
    if (/api\.(?:rightTab|openTab|inspect)\(/.test(code))
      assert.ok(dependencies.has('core:layout'), entry.id + ' must declare the right-tab provider');
    if (entry.required || entry.defaultEnabled) assert.equal(mounted.get(entry.id)?.browser, entry.browser);
  }
  await request('/settings', 'PATCH', { plugins: { files: false, shell: true } });
  const changed = (await request('/bootstrap')).body.ui;
  assert.ok(!changed.some(({ id }: { id: string }) => id === 'files'));
  assert.ok(changed.some(({ id }: { id: string }) => id === 'shell' && browser.has(id)));
});
