import { existsSync, readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = join(root, 'packages');
const web = join(packages, 'web');
const capabilityNames = ['agent','files','models','plugins','runs','session-helper','sessions','settings','shell','skills','subagents','ui','workspaces'];
const infrastructureNames = ['contracts','host','kernel','platform','transport'];
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
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
    const target = specifier.startsWith('.') ? resolve(file, '..', specifier).replace(/\.js$/, '.ts') : specifier;
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
    assert.ok(existsSync(join(owned,'host.ts')) || existsSync(join(owned,'client.ts')), name + ' has no entry');
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
test('each internal Cordis provider declares every required scoped service read', () => {
  const indexPath = join(packages, 'host', 'composition.ts');
  const indexSource = ts.createSourceFile(indexPath, readFileSync(indexPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  for (const statement of indexSource.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.')) imports.set(item.name.text,
        resolve(dirname(indexPath), specifier).replace(/\.js$/, '.ts'));
    }
  }
  const entries = indexSource.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => ts.isIdentifier(item.name) && item.name.text === 'system');
  assert.ok(entries?.initializer && ts.isArrayLiteralExpression(entries.initializer), 'System capabilities have a declarative composition root');
  const property = (node: ts.ObjectLiteralExpression, name: string) =>
    node.properties.find((item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  for (const entry of entries.initializer.elements) {
    assert.ok(ts.isObjectLiteralExpression(entry), 'System entries are static objects');
    const id = property(entry, 'id')?.initializer;
    const inject = property(entry, 'inject')?.initializer;
    const setup = property(entry, 'setup')?.initializer;
    assert.ok(id && ts.isStringLiteral(id) && inject && ts.isArrayLiteralExpression(inject)
      && setup && ts.isIdentifier(setup), 'System metadata declares ID, inject and setup');
    const allowed = new Set(inject.elements.map((value) => {
      assert.ok(ts.isStringLiteral(value), 'Inject names are literal strings');
      return value.text;
    }));
    const owner = imports.get(setup.text);
    assert.ok(owner && existsSync(owner), id.text + ' must have an owning implementation');
    let code = readFileSync(owner, 'utf8');
    // Account for a host delegating its setup to a same-feature registration function.
    const hostAst = ts.createSourceFile(owner, code, ts.ScriptTarget.Latest, true);
    for (const statement of hostAst.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const item of bindings.elements) {
        const alias = item.name.text;
        if (!new RegExp('\\b' + alias + '\\s*\\(\\s*ctx\\s*[,)]').test(code)) continue;
        const imported = resolve(dirname(owner), statement.moduleSpecifier.text).replace(/\.js$/, '.ts');
        if (imported.startsWith(dirname(owner) + sep) && existsSync(imported)) code += readFileSync(imported, 'utf8');
      }
    }
    const provided = new Set([...code.matchAll(/ctx\.provide\(['"]([A-Za-z]\w+)['"]/g)].map((match) => match[1]));
    const accessed = [...code.matchAll(/ctx\.(harness[A-Za-z]\w*)\b/g)].map((match) => match[1]);
    for (const name of accessed) {
      assert.ok(allowed.has(name) || provided.has(name),
        id.text + ' reads ' + name + ' without an inject declaration; optional services must use ctx.get()');
    }
  }
});

/** The private package manifests are architectural declarations, not separate releases. */
test('all internal packages declare exact source dependencies and form a DAG', () => {
  const names = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
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
      assert.equal(link, 'file:../' + target, name + ': invalid local dependency ' + id);
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
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier).replace(/\\.js$/, '.ts');
      assert.ok(target.startsWith(packages + sep), file + ' imports outside packages/: ' + specifier);
      const owner = target.slice(packages.length + 1).split(sep)[0];
      assert.ok(names.includes(owner), file + ' imports an unknown package: ' + specifier);
      if (owner !== name) actual.add(owner);
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
  assert.equal(rootManifest.workspaces, undefined, 'Do not install private packages as independent workspaces');
});
