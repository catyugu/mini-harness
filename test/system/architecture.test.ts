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
  miniHarness?: { api: string[] };
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = join(root, 'packages');
const prefix = '@mini-harness/';
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

function checkCycles(graph: Map<string, Set<string>>, kind: string) {
  const visiting = new Set<string>();
  const checked = new Set<string>();
  function visit(name: string) {
    assert.ok(!visiting.has(name), kind + ' cycle: ' + [...visiting, name].join(' -> '));
    if (checked.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    checked.add(name);
  }
  for (const name of graph.keys()) visit(name);
}

test('workspace dependencies use domain APIs and keep providers at the application boundary', () => {
  assert.ok(!manifests.has('contracts'), 'Remove the central contracts package');
  const runtime = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  for (const [name, manifest] of manifests) {
    assert.equal(manifest.name, prefix + name);
    assert.equal(manifest.private, true, 'Only the root package is published');
    for (const entry of manifest.miniHarness?.api ?? []) assert.ok(manifest.exports?.[entry], name + ' API ' + entry);
    const directory = join(packages, name);
    const actual = new Set<string>();
    const loaded = new Set<string>();
    for (const file of sources(directory)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const { literal: { text: specifier }, typeOnly } of moduleReferences(source)) {
        const reason = file + ' ' + (typeOnly ? 'references ' : 'loads ') + specifier;
        if (specifier.startsWith('@earendil-works/pi-'))
          assert.equal(file, join(packages, 'models', 'pi-adapter.ts'), reason);
        if (specifier.startsWith('.')) {
          assert.ok(resolve(dirname(file), specifier).startsWith(directory + sep), reason);
          continue;
        }
        assert.ok(specifier !== 'mini-harness/plugin' && specifier !== 'mini-harness/browser-plugin', reason);
        if (!specifier.startsWith(prefix)) continue;
        const [owner, ...parts] = specifier.slice(prefix.length).split('/');
        const entry = './' + parts.join('/');
        const dependency = manifests.get(owner);
        const target = dependency?.exports?.[entry] && resolve(packages, owner, dependency.exports[entry]);
        assert.ok(target && target.startsWith(join(packages, owner) + sep) && existsSync(target), reason);
        assert.notEqual(name, owner, reason);
        assert.notEqual(owner, 'host', reason);
        assert.notEqual(owner, 'sdk', reason);
        if (name !== 'host') assert.ok(dependency?.miniHarness?.api.includes(entry), reason);
        actual.add(owner);
        if (!typeOnly) loaded.add(owner);
      }
    }
    assert.deepEqual(manifest.dependencies ?? {},
      Object.fromEntries([...actual].map((owner) => [prefix + owner, 'workspace:*'])), name);
    declared.set(name, actual);
    runtime.set(name, loaded);
  }

  for (const name of ['kernel', 'platform']) assert.equal(declared.get(name)?.size, 0, name);
  for (const name of ['plugin-api', 'transport', 'ui-runtime'])
    for (const dependency of declared.get(name) ?? [])
      assert.ok(['kernel', 'platform', 'transport', 'ui-runtime'].includes(dependency), name + ' depends on ' + dependency);
  checkCycles(runtime, 'Runtime dependency');
  checkCycles(declared, 'Workspace dependency');
  assert.ok(Object.keys(readManifest(join(root, 'package.json')).dependencies ?? {}).every((name) => !name.startsWith(prefix)));
});
