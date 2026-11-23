import { expectPresent } from '../support/required.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { plugins } from '#mini-harness/host/composition.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = join(root, 'packages');
const web = join(packages, 'web');
const prefix = '#mini-harness/';
const manifests = new Map(readdirSync(packages, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) =>
  [name, JSON.parse(readFileSync(join(packages, name, 'package.json'), 'utf8'))]));

function workspaceTarget(specifier: string) {
  const [owner, ...parts] = specifier.slice(prefix.length).split('/');
  const entry = manifests.get(owner)?.exports?.['./' + parts.join('/').replace(/\.js$/, '')];
  assert.ok(entry, 'Missing workspace export: ' + specifier);
  const directory = join(packages, owner);
  const target = resolve(directory, entry);
  assert.ok(target.startsWith(directory + sep) && existsSync(target), 'Invalid workspace export: ' + specifier);
  return { owner, target };
}
const capabilityNames = ['agent','approvals','file-access','files','models','plugins','process-execution','runs','sandbox','session-helper','sessions','settings','shell','skills','subagents','tools','ui','workspaces'];
const infrastructureNames = ['contracts','host','kernel','platform','transport'];
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() && entry.name !== 'node_modules' ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
const production = (path: string) => !path.split(/[\\/]/).includes('tests');
function dependencies(file: string) {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const clause = statement.importClause;
    const typeOnly = Boolean(clause?.isTypeOnly ||
      (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.every((item) => item.isTypeOnly)));
    const specifier = statement.moduleSpecifier.text;
    const target = specifier.startsWith(prefix) ? workspaceTarget(specifier).target :
      specifier.startsWith('.') ? resolve(file, '..', specifier).replace(/\.js$/, '.ts') : specifier;
    return [{ specifier, target, typeOnly }];
  });
}
test('one package tree, with feature-owned tests and no legacy source axes', () => {
  for (const old of ['src','features','web']) assert.equal(existsSync(join(root,old)), false);
  for (const name of capabilityNames) {
    const owned = join(packages,name);
    assert.ok(existsSync(owned), name + ' lacks capability');
    if (['files','skills','shell','subagents','session-helper'].includes(name))
      assert.ok(existsSync(join(owned,'manifest.ts')), name + ' lacks manifest');
    assert.ok(existsSync(join(owned,'host.ts')) || existsSync(join(owned,'manifest.ts')), name + ' has no entry');
  }
  assert.ok(existsSync(join(packages,'plugins','manager.ts')));
  assert.ok(existsSync(join(packages,'host','application.ts')));
  assert.ok(existsSync(join(packages,'kernel','mounts.ts')));
});
test('infrastructure tests are centralized in test/', () => {
  const stray = infrastructureNames.flatMap(name => files(join(packages,name)))
    .filter(path => /\\.(?:test|spec)\\.ts$/.test(path) || path.split(/[\\/]/).includes('tests'));
  assert.deepEqual(stray, []);
});
test('capabilities do not import other capabilities concrete source', () => {
  for (const name of capabilityNames) {
    const owned = join(packages,name);
    for (const file of files(owned).filter(production)) for (const dep of dependencies(file)) {
      if (name === 'plugins' && dep.target.startsWith(owned + sep)) continue;
      for (const other of capabilityNames.filter(other=>other!==name)) {
        assert.equal(dep.target.startsWith(join(packages, other) + sep), false,
          file + ' imports another feature concrete file: ' + dep.specifier);
      }
      assert.notEqual(dep.target, join(packages,'host','server.ts'), file + ' imports HTTP server');
    }
  }
});
test('the kernel remains independent of product runtime', () => {
  for (const file of files(join(packages,'kernel'))) for (const dep of dependencies(file))
    assert.equal(dep.target.startsWith(packages + sep), false, file + ' depends on product code');
  for (const file of files(join(packages,'ui-runtime')).filter(production)) for (const dep of dependencies(file))
    for (const feature of capabilityNames)
      assert.equal(dep.target.startsWith(join(packages,feature) + sep), false, file + ' depends on a feature');
  for (const file of files(join(packages,'contracts'))) for (const dep of dependencies(file))
    for (const name of capabilityNames)
      assert.equal(dep.target.startsWith(join(packages,name) + sep), false, file + ' depends on feature');
});

test('native execution contracts and feature code do not depend on the coding SDK', () => {
  const adapter = join(packages, 'models', 'pi-adapter.ts');
  for (const file of files(packages).filter(production)) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /@earendil-works\/pi-coding-agent|\bharnessPi\b|\bcreateAgentSession\b|\bAgentSession\b/,
      file + ' retains an SDK-owned execution interface');
    if (source.includes('@earendil-works/pi-ai')) assert.equal(file, adapter,
      file + ' bypasses the native LLM contract');
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@earendil-works/pi-coding-agent'], undefined);
  assert.ok(manifest.dependencies['@earendil-works/pi-ai']);
});

test('browser boot mounts a declared graph instead of constructing feature state', () => {
  const boot = readFileSync(join(packages, 'ui-runtime', 'boot.ts'), 'utf8');
  assert.doesNotMatch(boot, /['"]\/(?:sessions|workspaces|settings|models|providers|approvals)(?:['"?\/])/);
  assert.doesNotMatch(boot, /\b(?:miniSelection|miniSessions|miniWorkspaces|miniSettingsData|miniModels|miniPluginData|miniApprovals)\b/);
  const browserProviders = new Set(plugins.flatMap(({ browserProvides }) => browserProvides ?? []));
  for (const service of ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniSettingsData', 'miniModels', 'miniPluginData', 'miniApprovals'])
    assert.ok(browserProviders.has(service), service + ' is not owned by a browser plugin');
});
test('browser values never load host-only modules', () => {
  const clients = capabilityNames.flatMap(name => [
    ...[join(packages,name,'client.ts'), join(packages,name,'browser.ts')].filter(existsSync),
    ...(existsSync(join(packages,name,'browser')) ? files(join(packages,name,'browser')).filter(production) : [])
  ]);
  for (const file of [...files(web).filter(production), ...files(join(packages, 'ui-runtime')).filter(production), ...files(join(packages, 'ui-layout')).filter(production), ...files(join(packages, 'ui-primitives')).filter(production), ...files(join(packages, 'ui-theme')).filter(production), ...clients]) for (const dep of dependencies(file)) {
    if (dep.typeOnly) continue;
    for (const name of ['host','platform','transport','kernel']) {
      assert.equal(dep.target.startsWith(join(packages,name) + sep), false,
        file + ' loads host implementation: ' + dep.specifier);
    }
  }
});
test('each capability declares the services it reads and publishes', () => {
  const composition = readFileSync(join(packages, 'host', 'composition.ts'), 'utf8');
  const descriptors = [...composition.matchAll(/import { manifest as \w+ } from ['"]#mini-harness\/([^'"]+)\.js['"]/g)];
  assert.equal(descriptors.length, plugins.length);
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  for (const [, specifier] of descriptors) {
    const path = join(packages, specifier + '.ts');
    const descriptor = readFileSync(path, 'utf8');
    const id = expectPresent(descriptor.match(/id: '([^']+)'/), 'plugin identifier')[1];
    const plugin = byId.get(id);
    assert.ok(plugin);
    let source = descriptor;
    const impl = /import { setup } from '\.\/([^']+)\.js'/.exec(descriptor);
    if (impl) {
      const host = readFileSync(join(dirname(path), impl[1] + '.ts'), 'utf8');
      source += host;
      if (/register(?:Session)?Routes\(ctx\)/.test(host)) source += readFileSync(join(dirname(path), 'routes.ts'), 'utf8');
    }
    const provided = [...source.matchAll(/ctx\.provide\('([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(provided.sort(), [...(plugin.provides ?? [])].sort(), id);
    const required = new Set([...(plugin.inject ?? []), ...provided]);
    const reads = [...source.matchAll(/ctx\.(harness\w+)\b/g)].map((match) => match[1]);
    for (const [, destructure] of source.matchAll(/(?:const|let)\s+{([^}]+)}\s*=\s*ctx\b/g))
      for (const [name] of destructure.matchAll(/harness\w+/g)) reads.push(name);
    for (const service of reads) assert.ok(required.has(service), id + ' reads undeclared service ' + service);
    for (const [, service] of source.matchAll(/ctx\.get\('([^']+)'/g))
      assert.ok(plugin.optional?.includes(service), id + ' reads undeclared optional service ' + service);
  }
  for (const removed of ['ui/manifest.ts', 'sessions/operations.ts', 'web/models/browser-state.ts'])
    assert.equal(existsSync(join(packages, removed)), false);
});

/** The private package manifests are architectural declarations, not separate releases. */
test('all internal packages declare exact source dependencies and form a DAG', () => {
  const names = [...manifests.keys()].sort();
  const declared = new Map<string, Set<string>>();
  for (const name of names) {
    const manifestFile = join(packages, name, 'package.json');
    assert.ok(existsSync(manifestFile), 'Missing package.json for ' + name);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.name, '@mini-harness/' + name);
    assert.equal(manifest.version, '0.0.0');
    assert.equal(manifest.private, true, name + ' must not be published separately');
    assert.equal(manifest.type, 'module');
    const deps = manifest.dependencies ?? {};
    assert.deepEqual(Object.keys(deps).sort(),
      Object.keys(deps).filter((dep) => dep.startsWith('@mini-harness/')).sort(),
      name + ': third-party dependencies are owned by the single root package');
    const internal = new Set<string>();
    for (const [id, link] of Object.entries(deps)) {
      const target = id.slice('@mini-harness/'.length);
      assert.ok(names.includes(target), name + ': unknown dependency ' + id);
      assert.notEqual(target, name, name + ': self-dependency');
      assert.equal(link, 'workspace:*', name + ': invalid local dependency ' + id);
      internal.add(target);
    }
    declared.set(name, internal);
  }

  // Traverse the TypeScript syntax tree so type-only imports, re-exports and
  // literal dynamic imports count as dependencies too.
  function references(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const result: string[] = [];
    function walk(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        result.push(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
        result.push(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(source);
    return result;
  }

  for (const name of names) {
    const actual = new Set<string>();
    for (const file of files(join(packages, name)).filter(production)) for (const specifier of references(file)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        assert.ok(target.startsWith(join(packages, name) + sep), file + ' crosses a workspace boundary by path: ' + specifier);
        continue;
      }
      if (!specifier.startsWith(prefix)) continue;
      const { owner } = workspaceTarget(specifier);
      assert.notEqual(owner, name, file + ' imports its own workspace package by name');
      actual.add(owner);
      if (name !== 'host') assert.notEqual(owner, 'host', file + ' imports host composition');
      
      if (name !== 'host' && name !== 'plugins') assert.notEqual(owner, 'kernel', file + ' imports Cordis kernel');
    }
    assert.deepEqual([...actual].sort(), [...declared.get(name)!].sort(),
      name + ': manifest and production imports differ (including type-only edges)');
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(name: string, path: string[]): void {
    if (visiting.has(name)) assert.fail('Internal package dependency cycle: ' + [...path, name].join(' -> '));
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of declared.get(name)!) visit(target, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name, []);
  assert.ok(!names.includes('web-app'), 'Legacy browser app entry must not exist');
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(rootManifest.name, 'mini-harness');
  assert.ok(existsSync(join(root, 'pnpm-workspace.yaml')));
  assert.ok(existsSync(join(root, 'pnpm-lock.yaml')));
  assert.ok(Object.keys({ ...rootManifest.dependencies, ...rootManifest.devDependencies }).every((name) => !name.startsWith(prefix)));
});
