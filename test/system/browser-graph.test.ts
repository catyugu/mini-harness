import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { browserEntries } from '../../packages/ui/manifest.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const owned = new Set(browserEntries.map(({ id }) => id));

test('browser graph declares one exported implementation and valid dependencies for each core plugin', () => {
  assert.equal(owned.size, browserEntries.length, 'Duplicate browser plugin ids');
  const started = new Set<string>();
  for (const entry of browserEntries) {
    assert.match(entry.id, /^core:[a-z-]+$/);
    assert.match(entry.browser, /^\/packages\/[a-z-]+(?:\/[a-z-]+)*\.js$/);
    const source = resolve(root, entry.browser.slice(1).replace(/\.js$/, '.ts'));
    assert.ok(existsSync(source), 'Missing browser entry: ' + entry.browser);
    const ast = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.some((statement) => ts.isExportAssignment(statement) && !statement.isExportEquals),
      'Missing default browser plugin export: ' + entry.browser);
    for (const required of entry.requires ?? []) {
      assert.ok(owned.has(required), 'Unknown core browser dependency: ' + required);
      assert.ok(started.has(required), 'Core browser graph must declare dependencies first: ' + entry.id + ' -> ' + required);
    }
    started.add(entry.id);
  }
});
