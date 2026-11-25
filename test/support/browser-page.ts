import assert from 'node:assert/strict';
import ts from 'typescript';
import { moduleReferences } from '../../scripts/module-references.ts';

export function browserPage(html: string) {
  const boot = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  const map = /<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(boot && map, 'Missing browser entry or import map');
  return { boot, imports: (JSON.parse(map) as { imports: Record<string, string> }).imports };
}

export async function verifyBrowserGraph(
  base: string,
  entries: string[],
  imports: Record<string, string> = {},
) {
  const pending = [...entries];
  const seen = new Set<string>();
  for (const path of pending) {
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await fetch(base + path);
    assert.equal(response.status, 200, 'Missing browser module: ' + path);
    const source = ts.createSourceFile(
      path,
      await response.text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const { literal, typeOnly } of moduleReferences(source)) {
      if (typeOnly) continue;
      const specifier = imports[literal.text] ?? literal.text;
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('/'),
        'Unresolved browser import in ' + path + ': ' + literal.text,
      );
      const target = new URL(specifier, response.url);
      assert.equal(target.origin, base, 'Browser module has an off-origin import: ' + path);
      pending.push(target.pathname);
    }
  }
}
