import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const prefix = '@mini-harness/';
const exportsByPackage = new Map(
  readdirSync('packages').map((name) => [name,
    JSON.parse(readFileSync(resolve('packages', name, 'package.json'), 'utf8')).exports ?? {}])
);

function rewrite(file) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(prefix)) return;
  const declaration = file.endsWith('.d.ts');
  const output = declaration ? 'dist/types/packages' : 'dist/packages';
  const ast = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
    if (literal && ts.isStringLiteral(literal) && literal.text.startsWith(prefix)) {
      const [name, ...subpath] = literal.text.slice(prefix.length).split('/');
      const entry = exportsByPackage.get(name)?.['./' + subpath.join('/')];
      if (!entry) throw new Error('Missing workspace export ' + literal.text + ' in ' + file);
      const target = resolve(output, name, entry.replace(/(?:\.d)?\.ts$/, '.js'));
      const emitted = declaration ? target.replace(/\.js$/, '.d.ts') : target;
      // Browser vendor files are copied after emission.
      if (!existsSync(emitted) && !entry.startsWith('./vendor/')) throw new Error('Missing build output ' + emitted);
      const path = relative(dirname(file), target).split(sep).join('/');
      edits.push({ from: literal.getStart(ast), to: literal.end, value: JSON.stringify(path.startsWith('.') ? path : './' + path) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let content = original;
  for (const { from, to, value } of edits.reverse()) content = content.slice(0, from) + value + content.slice(to);
  if (edits.length) writeFileSync(file, content);
}

function emit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) emit(path);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) rewrite(path);
  }
}
emit('dist');
