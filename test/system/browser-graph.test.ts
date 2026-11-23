import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { plugins } from '../../packages/host/composition.js';
import { fixture } from '../support/api-fixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('the composed browser graph is derived from the mounted capability descriptors', async (t) => {
  const { request } = await fixture(t);
  const { body } = await request('/bootstrap');
  const mounted = new Map<string, { browser?: string }>(body.ui.map((entry) => [entry.id, entry]));
  assert.equal(mounted.size, body.ui.length);
  assert.deepEqual(Object.keys(body), ['ui']);
  const browser = new Set(plugins.filter(({ browser }) => browser).map(({ id }) => id));
  for (const entry of plugins.filter(({ browser }) => browser)) {
    assert.match(entry.browser, /^\/packages\/[a-z-]+(?:\/[a-z-]+)*\.js$/);
    const source = resolve(root, entry.browser.slice(1).replace(/\.js$/, '.ts'));
    assert.ok(existsSync(source), 'Missing browser entry: ' + entry.browser);
    const ast = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.some((statement) => ts.isExportAssignment(statement) && !statement.isExportEquals),
      'Missing default browser plugin export: ' + entry.browser);
    for (const required of entry.browserRequires ?? []) assert.ok(browser.has(required));
    if (entry.required || entry.defaultEnabled) assert.equal(mounted.get(entry.id)?.browser, entry.browser);
  }
  await request('/settings', 'PATCH', { plugins: { files: false, shell: true } });
  const changed = (await request('/bootstrap')).body.ui;
  assert.ok(!changed.some(({ id }) => id === 'files'));
  assert.ok(changed.some(({ id }) => id === 'shell' && browser.has(id)));
});
