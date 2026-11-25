import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { moduleReferences } from '../../scripts/module-references.ts';

interface Manifest {
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = join(root, 'packages');
const prefix = '@mini-harness/';
const manifests = new Map(
  readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => [name, readManifest(join(packages, name, 'package.json'))]),
);

function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const { name } = entry;
    const path = join(directory, name);
    return entry.isDirectory()
      ? name === 'node_modules' || name === 'tests'
        ? []
        : sources(path)
      : name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(name)
        ? [path]
        : [];
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

test('workspace dependencies are acyclic and browser imports are browser-safe', async () => {
  const browserModules = new Map<string, string[]>();
  const browserRoots: string[] = [];
  const runtime = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  for (const [name, manifest] of manifests) {
    const directory = join(packages, name);
    const actual = new Set<string>();
    const loaded = new Set<string>();
    for (const file of sources(join(directory, 'src'))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      browserModules.set(file, imports);
      const area = relative(directory, file).split(sep)[1];
      if (area === 'browser' && !file.endsWith('.d.ts')) browserRoots.push(file);
      for (const {
        literal: { text: specifier },
        typeOnly,
      } of moduleReferences(source)) {
        const reason = file + ' ' + (typeOnly ? 'references ' : 'loads ') + specifier;
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          assert.ok(target.startsWith(directory + sep), reason);
          if (!typeOnly) imports.push(target);
          if (area === 'browser' || area === 'shared')
            assert.ok(!relative(directory, target).split(sep).includes('server'), reason);
          continue;
        }
        if (specifier === 'mini-harness/cordis' || specifier.startsWith('@codemirror/')) continue;
        if (!specifier.startsWith(prefix)) {
          if (!typeOnly) imports.push(specifier);
          continue;
        }
        const [owner, ...parts] = specifier.slice(prefix.length).split('/');
        const entry = './' + parts.join('/');
        const dependency = manifests.get(owner);
        const target = dependency?.exports?.[entry] && resolve(packages, owner, dependency.exports[entry]);
        assert.ok(target && target.startsWith(join(packages, owner) + sep) && existsSync(target), reason);
        actual.add(owner);
        if (area === 'browser' || area === 'shared')
          assert.ok(!relative(join(packages, owner), target).split(sep).includes('server'), reason);
        if (!typeOnly) {
          loaded.add(owner);
          imports.push(target);
        }
      }
    }
    assert.deepEqual(
      manifest.dependencies ?? {},
      Object.fromEntries([...actual].map((owner) => [prefix + owner, 'workspace:*'])),
      name,
    );
    declared.set(name, actual);
    runtime.set(name, loaded);
  }

  const visited = new Set<string>();
  function checkBrowser(file: string, importer?: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (importer) {
      const path = relative(packages, file).split(sep);
      assert.ok(
        path[1] === 'src' && (path[2] === 'browser' || path[2] === 'shared'),
        'Browser module loads ' + file + ' from ' + importer,
      );
    }
    const imports = browserModules.get(file);
    if (!imports) {
      assert.ok(existsSync(file.replace(/\.ts$/, '.d.ts')), 'Missing browser module ' + file);
      return;
    }
    for (const target of imports) checkBrowser(target, file);
  }
  for (const file of browserRoots) checkBrowser(file);

  checkCycles(runtime, 'Runtime dependency');
  checkCycles(declared, 'Workspace dependency');
  assert.ok(
    Object.keys(readManifest(join(root, 'package.json')).dependencies ?? {}).every(
      (name) => !name.startsWith(prefix),
    ),
  );
});
