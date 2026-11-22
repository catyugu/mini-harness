import { readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = new URL('../../src/', import.meta.url);

function imports(path: string) {
  return ts.preProcessFile(readFileSync(new URL(path, source), 'utf8')).importedFiles
    .map(({ fileName }) => fileName);
}

test('the plugin host and built-ins use service contracts without importing the runtime or server', () => {
  const builtins = readdirSync(new URL('builtins/', source)).filter((file) => file.endsWith('.ts'));
  for (const path of ['kernel/plugins.ts', 'kernel/plugin-api.ts', ...builtins.map((file) => 'builtins/' + file)]) {
    for (const dependency of imports(path))
      assert.doesNotMatch(dependency, /(?:^|\/)(agent|server|session-routes)\.js$/, path + ' imports ' + dependency);
  }
});

test('only the composition root imports built-in capabilities into core', () => {
  for (const path of readdirSync(source).filter((file) => file.endsWith('.ts') && file !== 'kernel/runtime.ts')) {
    for (const dependency of imports(path))
      assert.doesNotMatch(dependency, /(?:^|\/)builtins\//, path + ' imports ' + dependency);
  }
});

test('only the HTTP composition root imports the concrete runtime', () => {
  for (const path of readdirSync(source).filter((file) => file.endsWith('.ts') && !['server.ts'].includes(file))) {
    for (const dependency of imports(path))
      assert.doesNotMatch(dependency, /(?:^|\/)agent\.js$/, path + ' imports ' + dependency);
  }
});

test('browser modules import server-side types only, never Node runtime values', () => {
  const web = new URL('../../web/', import.meta.url);
  for (const directory of ['', 'builtins/']) {
    for (const file of readdirSync(new URL(directory, web)).filter((name) => name.endsWith('.ts'))) {
      const sourceFile = ts.createSourceFile(file, readFileSync(new URL(directory + file, web), 'utf8'),
        ts.ScriptTarget.Latest, true);
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
            !/(?:^|\/)src\//.test(statement.moduleSpecifier.text)) continue;
        const clause = statement.importClause;
        assert.ok(clause?.isTypeOnly ||
          (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((item) => item.isTypeOnly)),
          directory + file + ' imports a server runtime value from ' + statement.moduleSpecifier.text);
      }
    }
  }
});
