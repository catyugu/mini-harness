import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { plugins } from '@mini-harness/host/composition';
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
  const browserModules = new Map<string, string[]>();
  const browserRoots = [join(packages, 'sdk', 'src', 'browser-plugin.ts')];
  const runtime = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  for (const [name, manifest] of manifests) {
    assert.equal(manifest.name, prefix + name);
    assert.equal(manifest.private, true, 'Only the root package is published');
    assert.ok(existsSync(join(packages, name, 'README.md')), name + ' is missing its README');
    assert.ok(readdirSync(join(packages, name)).every((entry) =>
      ['README.md', 'package.json', 'src', 'tests', 'node_modules'].includes(entry)), name + ' has files outside its package layout');
    for (const entry of manifest.miniHarness?.api ?? []) assert.ok(manifest.exports?.[entry], name + ' API ' + entry);
    const directory = join(packages, name);
    const actual = new Set<string>();
    const loaded = new Set<string>();
    for (const file of sources(join(directory, 'src'))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      browserModules.set(file, imports);
      const area = relative(directory, file).split(sep)[1];
      if (area === 'browser' && !file.endsWith('.d.ts')) browserRoots.push(file);
      for (const { literal: { text: specifier }, typeOnly } of moduleReferences(source)) {
        const reason = file + ' ' + (typeOnly ? 'references ' : 'loads ') + specifier;
        if (specifier.startsWith('@earendil-works/pi-'))
          assert.equal(file, join(packages, 'models', 'src', 'server', 'pi-adapter.ts'), reason);
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          assert.ok(target.startsWith(directory + sep), reason);
          if (!typeOnly) imports.push(target.replace(/\.js$/, '.ts'));
          if (area === 'browser' || area === 'shared')
            assert.ok(!relative(directory, target).split(sep).includes('server'), reason);
          continue;
        }
        assert.ok(specifier !== 'mini-harness/plugin' && specifier !== 'mini-harness/browser-plugin', reason);
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
        assert.notEqual(owner, 'sdk', reason);
        if (name !== 'host') assert.ok(dependency?.miniHarness?.api.includes(entry), reason);
        actual.add(owner);
        if (area === 'browser' || area === 'shared')
          assert.ok(!relative(join(packages, owner), target).split(sep).includes('server'), reason);
        if (!typeOnly) { loaded.add(owner); imports.push(target); }
      }
    }
    assert.deepEqual(manifest.dependencies ?? {},
      Object.fromEntries([...actual].map((owner) => [prefix + owner, 'workspace:*'])), name);
    declared.set(name, actual);
    runtime.set(name, loaded);
  }

  const visited = new Set<string>();
  function checkBrowser(file: string, importer?: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (importer) {
      const path = relative(packages, file).split(sep);
      assert.ok(path[1] === 'src' && (path[2] === 'browser' || path[2] === 'shared'),
        'Browser module loads ' + file + ' from ' + importer);
    }
    const imports = browserModules.get(file);
    if (!imports) {
      assert.ok(existsSync(file.replace(/\.ts$/, '.d.ts')), 'Missing browser module ' + file);
      return;
    }
    for (const target of imports) checkBrowser(target, file);
  }
  for (const file of browserRoots) checkBrowser(file);

  const browserIds = new Set(plugins.filter(({ browser }) => browser).map(({ id }) => id));
  const browserServices = new Set([
    'miniProjections', 'miniSwitch', 'miniBrowserFailures',
    ...plugins.flatMap(({ browserProvides }) => browserProvides ?? [])
  ]);
  const descriptorOwners = new Map<string, string>();
  const composition = join(packages, 'host', 'src', 'composition.ts');
  const source = ts.createSourceFile(composition, readFileSync(composition, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const [owner, ...parts] = node.moduleSpecifier.text.slice(prefix.length).split('/');
    const entry = manifests.get(owner)?.exports?.['./' + parts.join('/')];
    if (!entry) continue;
    const manifest = readFileSync(join(packages, owner, entry), 'utf8');
    const id = /\bid: '([^']+)'/.exec(manifest)?.[1];
    if (id) descriptorOwners.set(id, owner);
  }
  for (const { id, browser, browserStyles, browserRequires, browserInject } of plugins) {
    if (!browser) { assert.ok(!browserStyles?.length, id + ' has styles without a browser entry'); continue; }
    const owner = descriptorOwners.get(id);
    assert.ok(owner, id + ' is missing its descriptor owner');
    const prefix = '/packages/' + owner + '/src/browser/';
    for (const resource of [browser, ...(browserStyles ?? [])]) {
      assert.ok(resource.startsWith(prefix), id + ' references a foreign resource: ' + resource);
      assert.ok(existsSync(join(root, resource.slice(1).replace(/\.js$/, '.ts'))), id + ' is missing ' + resource);
    }
    for (const dependency of browserRequires ?? []) assert.ok(browserIds.has(dependency), id + ' requires ' + dependency);
    for (const service of browserInject ?? []) assert.ok(browserServices.has(service), id + ' injects ' + service);
  }

  for (const name of ['kernel', 'platform']) assert.equal(declared.get(name)?.size, 0, name);
  for (const name of ['plugin-api', 'transport', 'ui-runtime'])
    for (const dependency of declared.get(name) ?? [])
      assert.ok(['kernel', 'platform', 'transport', 'ui-runtime'].includes(dependency), name + ' depends on ' + dependency);
  checkCycles(runtime, 'Runtime dependency');
  checkCycles(declared, 'Workspace dependency');
  assert.ok(Object.keys(readManifest(join(root, 'package.json')).dependencies ?? {}).every((name) => !name.startsWith(prefix)));
});
