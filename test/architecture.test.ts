import { existsSync, readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'src');
const web = join(root, 'web');
const features = join(root, 'features');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

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
    assert.ok(existsSync(join(path, 'manifest.ts')), name + ' lacks a manifest');
    assert.ok(existsSync(join(path, 'host.ts')) || existsSync(join(path, 'client.ts')), name + ' has no implementation');
    for (const file of files(path)) {
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

test('only composition roots import feature implementations', () => {
  for (const file of files(source)) {
    if (file === join(source, 'application.ts')) continue;
    for (const dependency of dependencies(file))
      assert.equal(dependency.target.startsWith(features + '/'), false, file + ' imports a feature: ' + dependency.specifier);
  }
});

test('Web modules and feature clients do not import Node runtime implementations', () => {
  const browserSources = [...files(web), ...readdirSync(features, { withFileTypes: true })
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
      assert.equal(dep.target, join(source, 'config.ts'), false,
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
  for (const path of files(join(source, 'services'))) {
    for (const dep of dependencies(path))
      assert.equal(dep.target.startsWith(features + '/'), false, path + ' must not import feature internals');
  }
});

test('contracts carry browser/session vocabulary without protocol forwarding shims', () => {
  assert.equal(existsSync(join(source, 'protocol.ts')), false);
  for (const file of [...files(web), ...files(join(source, 'services'))]) {
    for (const dep of dependencies(file)) {
      if (typeof dep.target !== 'string') continue;
      assert.equal(dep.target.endsWith('/src/protocol.ts'), false, file + ' imports protocol forwarding shim');
      assert.equal(dep.target.startsWith(join(source, 'services') + '/') && file.startsWith(web), false,
        file + ' imports concrete host service rather than contract');
    }
  }
});

test('application composition is outside the generic kernel', () => {
  assert.equal(existsSync(join(source, 'kernel', 'runtime.ts')), false);
  assert.equal(existsSync(join(source, 'kernel', 'plugins.ts')), false);
  assert.ok(existsSync(join(source, 'plugins', 'catalog.ts')));
  assert.ok(existsSync(join(source, 'plugins', 'host.ts')));
});
