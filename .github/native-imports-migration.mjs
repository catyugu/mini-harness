import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

let changedFiles = 0;
let rewrittenImports = 0;
function rewriteFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  const root = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
    if (literal && ts.isStringLiteral(literal) && literal.text.startsWith('@mini-harness/')) {
      const next = '#mini-harness/' + literal.text.slice('@mini-harness/'.length) + '.js';
      const quote = text[literal.getStart(root)];
      edits.push([literal.getStart(root), literal.end, quote + next + quote]);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  for (const [start, end, replacement] of edits.reverse()) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  if (edits.length) {
    fs.writeFileSync(file, text);
    changedFiles++;
    rewrittenImports += edits.length;
  }
}
function visitDirectory(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) visitDirectory(file);
    else if (file.endsWith('.ts')) rewriteFile(file);
  }
}
for (const dir of ['bin', 'packages', 'test', 'scripts']) visitDirectory(dir);
function replaceOnce(file, before, after) {
  const input = fs.readFileSync(file, 'utf8');
  if (input.split(before).length !== 2) throw new Error('Unexpected source in ' + file + ' near ' + before.slice(0, 50));
  fs.writeFileSync(file, input.replace(before, after));
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!pkg.scripts.build.includes(' && node scripts/resolve-imports.mjs')) throw new Error('Missing legacy import resolver build step');
pkg.scripts.build = pkg.scripts.build.replace(' && node scripts/resolve-imports.mjs', '');
pkg.imports = { '#mini-harness/*': { types: './dist/types/packages/*', default: './dist/packages/*' } };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const tsconfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
if (tsconfig.compilerOptions.strict !== true || tsconfig.compilerOptions.noImplicitAny !== true) throw new Error('Must keep full strict mode');
tsconfig.compilerOptions.paths = { '#mini-harness/*': ['./packages/*'] };
fs.writeFileSync('tsconfig.json', JSON.stringify(tsconfig, null, 2) + '\n');
replaceOnce('packages/web/index.html',
  '<script type="module" src="/packages/ui-runtime/boot.js"></script>',
  '<script type="importmap">{"imports":{"#mini-harness/":"/packages/"}}</script>\n<script type="module" src="/packages/ui-runtime/boot.js"></script>');
replaceOnce('test/system/architecture.test.ts', "const prefix = '@mini-harness/';", "const prefix = '#mini-harness/';");
replaceOnce('test/system/architecture.test.ts', "const entry = manifests.get(owner)?.exports?.['./' + parts.join('/')];",
  "const entry = manifests.get(owner)?.exports?.['./' + parts.join('/').replace(/\\.js$/, '')];");
replaceOnce('test/system/architecture.test.ts',
  "const descriptors = [...composition.matchAll(/import { manifest as \\w+ } from '@mini-harness\\/([^']+)'/g)];",
  "const descriptors = [...composition.matchAll(/import { manifest as \\w+ } from ['\"]#mini-harness\\/([^'\"]+)\\.js['\"]/g)];");
replaceOnce('test/system/security-assets.test.ts',
  "  const pending = ['/packages/ui-runtime/boot.js',",
  `  const html = await (await fetch(base + '/')).text();
  const mapBody = html.match(/<script type="importmap">([\\s\\S]*?)<\\/script>/)?.[1];
  if (!mapBody) throw new Error('Missing native import map');
  const aliases = (JSON.parse(mapBody) as { imports: Record<string, string> }).imports;
  assert.equal(aliases['#mini-harness/'], '/packages/');
  const pending = ['/packages/ui-runtime/boot.js',`);
replaceOnce('test/system/security-assets.test.ts',
  `        assert.ok(specifier.startsWith('.') || specifier.startsWith('/'),
          'Unbundled bare browser import in ' + path + ': ' + specifier);
        pending.push(new URL(specifier, base + path).pathname);`,
  `        const modulePath = specifier.startsWith('#mini-harness/')
          ? aliases['#mini-harness/'] + specifier.slice('#mini-harness/'.length) : specifier;
        assert.ok(modulePath.startsWith('.') || modulePath.startsWith('/'),
          'Unmapped bare browser import in ' + path + ': ' + specifier);
        pending.push(new URL(modulePath, base + path).pathname);`);
fs.rmSync('scripts/resolve-imports.mjs');
console.log('Native Node/browser imports enabled:', { changedFiles, rewrittenImports });
