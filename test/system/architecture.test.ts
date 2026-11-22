import { existsSync, readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = join(root, 'src');
const web = join(root, 'web');
const features = join(root, 'features');

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

test('each built-in capability owns one manifest and co-located host/client entries', () => {
  assert.equal(existsSync(join(source, 'builtins')), false);
  assert.equal(existsSync(join(web, 'builtins')), false);
  const names = readdirSync(features, { withFileTypes: true }).filter((dir) => dir.isDirectory()).map((dir) => dir.name);
  assert.ok(names.includes('session-helper'));
  assert.equal(names.includes('message-copy') || names.includes('edit-resend'), false);
  for (const name of names) {
    const path = join(features, name);
    if (['files', 'skills', 'shell', 'subagents', 'session-helper'].includes(name))
      assert.ok(existsSync(join(path, 'manifest.ts')), name + ' lacks its user-visible manifest');
    assert.ok(existsSync(join(path, 'host.ts')) || existsSync(join(path, 'client.ts')), name + ' has no implementation');
    for (const file of files(path).filter(production)) {
      for (const dependency of dependencies(file)) {
        assert.notEqual(dependency.target, join(source, 'kernel', 'runtime.ts'), file + ' imports the concrete runtime');
        assert.notEqual(dependency.target, join(source, 'server.ts'), file + ' imports the HTTP server');
        if (typeof dependency.target === 'string' && dependency.target.startsWith(features + '/')) {
          assert.ok(dependency.target.startsWith(path + '/'), file + ' imports another feature: ' + dependency.target);
        }
      }
    }
  }
});

test('infrastructure and kernel tests are centralized under test/, never src/', () => {
  const stray = files(source).filter((path) =>
    /\.(?:test|spec)\.ts$/.test(path) || path.split(/[\\/]/).includes('tests'));
  assert.deepEqual(stray, [], 'Production src/ must not contain test files or tests/ directories');
  for (const path of [
    'plugins/browser-only-api.test.ts',
    'plugins/browser-plugin-manager.spec.ts',
    'plugins/install-api.test.ts',
    'plugins/install-race.test.ts',
    'plugins/lifecycle.test.ts',
    'plugins/records-api.test.ts',
    'settings/config.test.ts'
  ]) assert.ok(existsSync(join(root, 'test', path)), 'Expected infrastructure test under test/: ' + path);
});

test('only composition roots import feature implementations', () => {
  for (const file of files(source).filter(production)) {
    if (file === join(source, 'application.ts')) continue;
    for (const dependency of dependencies(file))
      assert.equal(dependency.target.startsWith(features + '/'), false, file + ' imports a feature: ' + dependency.specifier);
  }
});

test('Web modules and feature clients do not import Node runtime implementations', () => {
  const browserSources = [...files(web).filter(production), ...readdirSync(features, { withFileTypes: true })
    .filter((dir) => dir.isDirectory() && existsSync(join(features, dir.name, 'client.ts')))
    .map((dir) => join(features, dir.name, 'client.ts'))];
  for (const file of browserSources) {
    for (const dep of dependencies(file)) {
      if (typeof dep.target === 'string' && dep.target.startsWith(source + '/'))
        assert.ok(dep.typeOnly, file + ' imports a server runtime value from ' + dep.specifier);
    }
  }
});

test('host and browser kernel only depend on contracts, never feature/UI implementations', () => {
  for (const path of files(join(source, 'kernel'))) {
    for (const dep of dependencies(path)) {
      assert.equal(dep.target.startsWith(features + '/'), false, path + ' depends on a feature');
      for (const owner of ['services', 'adapters', 'transport', 'plugins']) {
        assert.equal(dep.target.startsWith(join(source, owner) + '/'), false,
          path + ' depends on a product adapter: ' + dep.specifier);
      }
      assert.notEqual(dep.target, join(source, 'config.ts'),
        path + ' depends on application settings');
    }
  }
  for (const path of files(join(web, 'kernel'))) {
    for (const dep of dependencies(path))
      assert.equal(dep.target.startsWith(join(web, 'ui') + '/'), false, path + ' depends on a UI component');
  }
  for (const path of files(join(source, 'contracts'))) {
    for (const dep of dependencies(path))
      assert.equal(dep.target.startsWith(join(source, 'kernel') + '/') || dep.target.startsWith(join(source, 'services') + '/')
        || dep.target.startsWith(join(source, 'adapters') + '/') || dep.target.startsWith(features + '/'), false,
      path + ' has a reverse implementation dependency');
  }
});

test('feature implementations are owned by their plugin, while host services use only platform seams', () => {
  for (const path of ['workspace.ts', 'inspection.ts', 'sandbox.ts'])
    assert.equal(existsSync(join(source, path)), false, path + ' must live with its owning capability');
  assert.equal(existsSync(join(source, 'services')), false, 'Service implementations must live in their owning features');
});

test('contracts carry browser/session vocabulary without protocol forwarding shims', () => {
  assert.equal(existsSync(join(source, 'protocol.ts')), false);
  for (const file of files(web).filter(production)) {
    for (const dep of dependencies(file)) {
      if (typeof dep.target !== 'string') continue;
      assert.equal(dep.target.endsWith('/src/protocol.ts'), false, file + ' imports protocol forwarding shim');
      assert.equal(dep.target.startsWith(join(source, 'services') + '/') && file.startsWith(web), false,
        file + ' imports concrete host service rather than contract');
    }
  }
});

test('co-located tests and plugin boundaries follow capability ownership', () => {
  for (const name of readdirSync(features, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    const owned = join(features, name);
    for (const file of files(owned).filter(production)) {
      for (const { target, typeOnly } of dependencies(file)) {
        if (target.startsWith(features + '/') && !target.startsWith(owned + '/'))
          assert.fail(file + ' imports another feature: ' + target);
        if (target.startsWith(join(source, 'server.ts')))
          assert.fail(file + ' imports server implementation');
      }
    }
  }
  assert.equal(existsSync(join(source, 'services')), false);
  assert.equal(existsSync(join(source, 'adapters')), false);
});

test('application composition is outside the generic kernel', () => {
  assert.equal(existsSync(join(source, 'kernel', 'runtime.ts')), false);
  assert.equal(existsSync(join(source, 'kernel', 'plugins.ts')), false);
  assert.ok(existsSync(join(source, 'plugins', 'catalog.ts')));
  assert.ok(existsSync(join(source, 'plugins', 'host.ts')));
});

test('each internal Cordis provider declares every required scoped service read', () => {
  const indexPath = join(features, 'index.ts');
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
        if (imported.startsWith(dirname(owner) + '/') && existsSync(imported)) code += readFileSync(imported, 'utf8');
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
