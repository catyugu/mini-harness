import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { profileDescriptors, readProfile } from '@mini-harness/host/profile';
import { moduleReferences } from '../../scripts/module-references.ts';

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  miniHarness?: { api?: string[]; profileModules?: Record<string, string> };
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

test('tracked TypeScript uses source specifiers and named type imports', () => {
  const roots = ['bin', 'packages', 'vendor', 'test', 'scripts', 'docs/examples'];
  function visit(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name !== 'node_modules') visit(path);
        continue;
      }
      assert.ok(!/\.[cm]?js$/.test(item.name), 'JavaScript source file: ' + path);
      if (!item.name.endsWith('.ts')) continue;
      const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const { literal } of moduleReferences(ast)) {
        assert.ok(
          !literal.text.startsWith('.') || !/\.[cm]?js$/.test(literal.text),
          'JavaScript source specifier: ' + path + ': ' + literal.text,
        );
      }
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        assert.ok(
          !bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 0,
          'Empty import declaration: ' + path,
        );
      }
    }
  }
  for (const directory of roots) visit(join(root, directory));
});

test('workspace dependencies use domain APIs and keep providers at the application boundary', async () => {
  assert.ok(!manifests.has('kernel'), 'Business plugins must use the vendored Cordis runtime directly');
  const browserModules = new Map<string, string[]>();
  const browserRoots: string[] = [];
  const runtime = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  for (const [name, manifest] of manifests) {
    assert.equal(manifest.name, prefix + name);
    assert.equal(manifest.private, true, 'Only the root package is published');
    assert.ok(existsSync(join(packages, name, 'README.md')), name + ' is missing its README');
    assert.ok(
      readdirSync(join(packages, name)).every((entry) =>
        ['README.md', 'package.json', 'src', 'tests', 'node_modules'].includes(entry),
      ),
      name + ' has files outside its package layout',
    );
    for (const entry of manifest.miniHarness?.api ?? [])
      assert.ok(manifest.exports?.[entry], name + ' API ' + entry);
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
        if (specifier.startsWith('@earendil-works/pi-'))
          assert.equal(file, join(packages, 'models', 'src', 'server', 'pi-adapter.ts'), reason);
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          assert.ok(target.startsWith(directory + sep), reason);
          if (!typeOnly) imports.push(target);
          if (area === 'browser' || area === 'shared')
            assert.ok(!relative(directory, target).split(sep).includes('server'), reason);
          continue;
        }
        if (specifier === 'mini-harness/cordis') continue;
        if (['@codemirror/commands', '@codemirror/state', '@codemirror/view'].includes(specifier)) {
          assert.equal(
            file,
            join(packages, 'conversation', 'src', 'browser', 'conversation', 'editor-vendor.ts'),
            reason,
          );
          continue;
        }
        if (!specifier.startsWith(prefix)) {
          if (!typeOnly) imports.push(specifier);
          continue;
        }
        const [owner, ...parts] = specifier.slice(prefix.length).split('/');
        const entry = './' + parts.join('/');
        const dependency = manifests.get(owner);
        const target = dependency?.exports?.[entry] && resolve(packages, owner, dependency.exports[entry]);
        assert.ok(target && target.startsWith(join(packages, owner) + sep) && existsSync(target), reason);
        assert.notEqual(name, owner, reason);
        assert.notEqual(owner, 'host', reason);
        if (name !== 'host') assert.ok(dependency?.miniHarness?.api?.includes(entry), reason);
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

  const entries = readProfile('web');
  const plugins = await profileDescriptors(entries);
  const moduleOwners = new Map(
    [...manifests].flatMap(([owner, manifest]) =>
      Object.keys(manifest.miniHarness?.profileModules ?? {}).map((specifier) => [specifier, owner] as const),
    ),
  );
  for (const { id, browser, browserStyles } of plugins) {
    if (!browser) {
      assert.ok(!browserStyles?.length, id + ' has styles without a browser entry');
      continue;
    }
    const owner = moduleOwners.get(entries.get(id)?.name ?? '');
    assert.ok(owner, id + ' is missing its descriptor owner');
    const prefix = '/packages/' + owner + '/src/browser/';
    for (const resource of [browser, ...(browserStyles ?? [])]) {
      assert.ok(resource.startsWith(prefix), id + ' references a foreign resource: ' + resource);
      assert.ok(
        existsSync(join(root, resource.slice(1).replace(/\.js$/, '.ts'))),
        id + ' is missing ' + resource,
      );
    }
  }

  assert.equal(declared.get('platform')?.size, 0);
  for (const dependency of declared.get('plugin-api') ?? []) assert.equal(dependency, 'platform');
  checkCycles(runtime, 'Runtime dependency');
  checkCycles(declared, 'Workspace dependency');
  assert.ok(
    Object.keys(readManifest(join(root, 'package.json')).dependencies ?? {}).every(
      (name) => !name.startsWith(prefix),
    ),
  );
});
