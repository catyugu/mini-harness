import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { moduleReferences } from '../../scripts/module-references.js';

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = join(root, 'packages');
const prefix = '@mini-harness/';
const foundations = new Set(['contracts', 'platform', 'transport', 'ui-runtime', 'ui-primitives']);
const manifests = new Map(readdirSync(packages, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => [name, readManifest(join(packages, name, 'package.json'))]));

function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const { name } = entry;
    const path = join(directory, name);
    return entry.isDirectory()
      ? name === 'node_modules' || name === 'tests' ? [] : sources(path)
      : name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

test('workspace imports match declared entrypoints and maintain capability boundaries', () => {
  const edges = new Map<string, Set<string>>();
  for (const [name, manifest] of manifests) {
    assert.equal(manifest.name, prefix + name);
    assert.equal(manifest.private, true, 'Only the root package is published');
    const directory = join(packages, name);
    const actual = new Set<string>();
    for (const file of sources(directory)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const { literal: { text: specifier } } of moduleReferences(source)) {
        const reason = file + ' imports ' + specifier;
        if (specifier.startsWith('@earendil-works/pi-')) assert.equal(name, 'models', reason);
        if (specifier.startsWith('.')) {
          assert.ok(resolve(dirname(file), specifier).startsWith(directory + sep), reason);
          continue;
        }
        if (!specifier.startsWith(prefix)) continue;
        const [owner, ...parts] = specifier.slice(prefix.length).split('/');
        const entry = manifests.get(owner)?.exports?.['./' + parts.join('/')];
        const target = entry && resolve(packages, owner, entry);
        assert.ok(target && target.startsWith(join(packages, owner) + sep) && existsSync(target), reason);
        assert.notEqual(name, owner, reason);
        assert.notEqual(name, 'kernel', reason);
        assert.notEqual(owner, 'host', reason);
        if (name !== 'host' && !foundations.has(owner))
          assert.ok(name === 'plugins' && owner === 'kernel', reason);
        actual.add(owner);
      }
    }
    assert.deepEqual(manifest.dependencies ?? {},
      Object.fromEntries([...actual].map((owner) => [prefix + owner, 'workspace:*'])), name);
    edges.set(name, actual);
  }

  const visiting = new Set<string>();
  const checked = new Set<string>();
  function check(name: string) {
    assert.ok(!visiting.has(name), 'Internal dependency cycle: ' + [...visiting, name].join(' -> '));
    if (checked.has(name)) return;
    visiting.add(name);
    for (const dep of edges.get(name) ?? []) check(dep);
    visiting.delete(name);
    checked.add(name);
  }
  for (const name of manifests.keys()) check(name);
  assert.ok(Object.keys(readManifest(join(root, 'package.json')).dependencies ?? {}).every((name) => !name.startsWith(prefix)));
});
