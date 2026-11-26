import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
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
      ? name === 'node_modules'
        ? []
        : sources(path)
      : name.endsWith('.ts')
        ? [path]
        : [];
  });
}

function checkCycles(graph: Map<string, Set<string>>) {
  const visiting = new Set<string>();
  const checked = new Set<string>();
  function visit(name: string) {
    assert.ok(!visiting.has(name), 'Workspace dependency cycle: ' + [...visiting, name].join(' -> '));
    if (checked.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    checked.add(name);
  }
  for (const name of graph.keys()) visit(name);
}

function references(file: string) {
  return moduleReferences(
    ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
  );
}

function workspaceTarget(specifier: string, file: string) {
  const [owner, ...parts] = specifier.slice(prefix.length).split('/');
  const entry = manifests.get(owner)?.exports?.['./' + parts.join('/')];
  const directory = join(packages, owner);
  const target = entry && resolve(directory, entry);
  assert.ok(
    target && target.startsWith(directory + sep) && existsSync(target),
    file + ' references ' + specifier,
  );
  return { owner, target };
}

test('workspace boundaries include tests and build scripts', () => {
  const support = join(root, 'test', 'support') + sep;
  for (const [directory, owner] of [
    ...[...manifests.keys()].map((name) => [join(packages, name), name]),
    ...['test', 'scripts', 'bin'].map((name) => [join(root, name), '']),
  ]) {
    for (const file of sources(directory)) {
      for (const {
        literal: { text: specifier },
      } of references(file)) {
        const reason = file + ' references ' + specifier;
        assert.ok(!/^(?:#|@\/|~\/)/.test(specifier), reason);
        if (isBuiltin(specifier)) assert.ok(specifier.startsWith('node:'), reason);
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          if (owner) {
            const isTest = relative(directory, file).split(sep)[0] === 'tests';
            assert.ok(target.startsWith(directory + sep) || (isTest && target.startsWith(support)), reason);
          } else {
            assert.ok(!target.startsWith(packages + sep), reason);
          }
        } else if (specifier.startsWith(prefix)) {
          const dependency = workspaceTarget(specifier, file);
          assert.notEqual(dependency.owner, owner, reason);
        }
      }
    }
  }
});

test('workspace dependencies are acyclic and browser imports are browser-safe', () => {
  const browserModules = new Map<string, string[]>();
  const browserRoots: string[] = [];
  const declared = new Map<string, Set<string>>();
  for (const [name, manifest] of manifests) {
    const directory = join(packages, name);
    const actual = new Set<string>();
    for (const file of sources(join(directory, 'src'))) {
      const imports: string[] = [];
      browserModules.set(file, imports);
      const area = relative(directory, file).split(sep)[1];
      if (area === 'browser' && !file.endsWith('.d.ts')) browserRoots.push(file);
      for (const {
        literal: { text: specifier },
        typeOnly,
      } of references(file)) {
        const reason = file + ' ' + (typeOnly ? 'references ' : 'loads ') + specifier;
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          assert.ok(target.startsWith(directory + sep), reason);
          if (!typeOnly) imports.push(target);
          continue;
        }
        if (specifier === 'mini-harness/cordis' || specifier.startsWith('@codemirror/')) continue;
        if (!specifier.startsWith(prefix)) {
          if (!typeOnly) imports.push(specifier);
          continue;
        }
        const { owner, target } = workspaceTarget(specifier, file);
        actual.add(owner);
        if (!typeOnly) imports.push(target);
      }
    }
    assert.deepEqual(
      manifest.dependencies ?? {},
      Object.fromEntries([...actual].map((owner) => [prefix + owner, 'workspace:*'])),
      name,
    );
    declared.set(name, actual);
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

  checkCycles(declared);
  assert.ok(
    Object.keys(readManifest(join(root, 'package.json')).dependencies ?? {}).every(
      (name) => !name.startsWith(prefix),
    ),
  );
});
