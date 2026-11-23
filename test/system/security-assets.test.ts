import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import ts from 'typescript';
import { createMiniHarnessServer } from '../../packages/host/server.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('compiled browser tests and host-only feature code are not public static assets', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  for (const asset of [
    '/packages/settings/tests/browser-layout.spec.js',
    '/packages/sessions/tests/browser-navigation.spec.js',
    '/packages/agent/pi-sessions.js',
    '/packages/shell/host.js',
    '/packages/subagents/delegation.js'
  ]) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 404, asset);
  }
  for (const entry of ['/packages/ui-runtime/boot.js', '/packages/ui-layout/browser.js']) {
    const response = await fetch(base + entry);
    assert.equal(response.status, 200, entry);
  }
  assert.equal((await fetch(base + '/packages/web-app/app.js')).status, 404, 'Removed legacy browser bootstrap');
  const publicAsset = await fetch(base + '/packages/ui-primitives/primitives.js');
  assert.equal(publicAsset.status, 200);

  assert.equal((await fetch(base + '/packages/plugins/browser-fields.js')).status, 404);

  // Check the transitive closure of browser ESM imports, including optional built-ins.
  // A single inaccessible import prevents the browser from starting at all.
  const bootstrap = await fetch(base + '/api/bootstrap', {
    headers: { Authorization: 'Bearer ' + app.token }
  });
  assert.equal(bootstrap.status, 200);
  const snapshot = await bootstrap.json() as { ui: { browser?: string }[] };
  const pending = ['/packages/ui-runtime/boot.js', ...snapshot.ui.flatMap(({ browser }) => browser ? [browser] : [])];
  const seen = new Set<string>();
  while (pending.length) {
    const path = pending.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    assert.ok(path.startsWith('/packages/'), 'Unexpected browser module path: ' + path);
    const response = await fetch(base + path);
    assert.equal(response.status, 200, 'Missing browser module: ' + path);
    const code = await response.text();
    const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function scan(node: ts.Node): void {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        specifier = node.arguments[0].text;
      }
      if (specifier !== undefined) {
        assert.ok(specifier.startsWith('.') || specifier.startsWith('/'),
          'Unbundled bare browser import in ' + path + ': ' + specifier);
        pending.push(new URL(specifier, base + path).pathname);
      }
      ts.forEachChild(node, scan);
    }
    scan(ast);
    assert.ok(seen.size < 300, 'Browser module graph unexpectedly large');
  }
});
