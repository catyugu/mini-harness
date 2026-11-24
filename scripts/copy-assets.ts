import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { moduleReferences } from './module-references.js';

const require = createRequire(import.meta.url);
mkdirSync('dist/packages/ui-runtime/assets', { recursive: true });
mkdirSync('dist/packages/ui-runtime/vendor', { recursive: true });
mkdirSync('dist/packages/ui-primitives/vendor', { recursive: true });
for (const asset of ['index.html', 'logo.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon.ico']) {
  copyFileSync(join('packages/ui-runtime/assets', asset), join('dist/packages/ui-runtime/assets', asset));
}
writeFileSync('dist/packages/ui-runtime/assets/theme.css', [
  readFileSync('packages/ui-theme/style.css', 'utf8'),
  readFileSync('packages/ui-primitives/style.css', 'utf8'),
  readFileSync('packages/ui-layout/frame.css', 'utf8'),
  readFileSync('packages/conversation/browser/conversation/style.css', 'utf8'),
  readFileSync('packages/settings/browser.css', 'utf8'),
  readFileSync('packages/ui-layout/responsive.css', 'utf8'),
  readFileSync('packages/plugins/browser.css', 'utf8'),
  readFileSync('packages/ui-layout/panels.css', 'utf8'),
  readFileSync('packages/shell/browser.css', 'utf8')
].join('\n'));
copyFileSync(join(dirname(require.resolve('marked')), 'marked.esm.js'), 'dist/packages/ui-primitives/vendor/marked.js');
copyFileSync(join(dirname(require.resolve('dompurify')), 'purify.es.mjs'), 'dist/packages/ui-primitives/vendor/purify.js');
copyFileSync(join(dirname(require.resolve('marked')), '..', 'LICENSE'), 'dist/packages/ui-primitives/vendor/marked.LICENSE');
copyFileSync(join(dirname(require.resolve('dompurify')), '..', 'LICENSE'), 'dist/packages/ui-primitives/vendor/purify.LICENSE');

mkdirSync('dist/types/packages/ui-runtime/vendor', { recursive: true });
copyFileSync('packages/ui-runtime/vendor/cordis.d.ts', 'dist/types/packages/ui-runtime/vendor/cordis.d.ts');
copyFileSync('packages/ui-runtime/vendor/cordis.LICENSE', 'dist/packages/ui-runtime/vendor/cordis.LICENSE');
const cordis = require.resolve('cordis');
const requireCordis = createRequire(cordis);
writeFileSync('dist/packages/ui-runtime/vendor/cordis.js', readFileSync(cordis, 'utf8').replaceAll('"cosmokit"', '"./cosmokit.js"'));
const cosmokit = dirname(requireCordis.resolve('cosmokit'));
copyFileSync(join(cosmokit, 'index.mjs'), 'dist/packages/ui-runtime/vendor/cosmokit.js');
copyFileSync(join(cosmokit, '..', 'LICENSE'), 'dist/packages/ui-runtime/vendor/cosmokit.LICENSE');


// Retain the two SDKs' declaration dependencies without publishing private provider types.
const declarationRoot = resolve('dist/types/packages');
const manifest: { exports: Record<string, { types: string }> } = JSON.parse(readFileSync('package.json', 'utf8'));
const publicDeclarations = new Set<string>();
function includeDeclaration(file: string) {
  if (!file.startsWith(declarationRoot + sep) || !file.endsWith('.d.ts'))
    throw new Error('SDK declaration is outside the published type directory: ' + file);
  if (publicDeclarations.has(file)) return;
  publicDeclarations.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const { literal: { text: specifier } } of moduleReferences(source)) {
    if (specifier.startsWith('.')) includeDeclaration(resolve(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
  }
}
for (const { types } of Object.values(manifest.exports)) includeDeclaration(resolve(types));
for (const entry of readdirSync(declarationRoot, { recursive: true, withFileTypes: true })) {
  const file = join(entry.parentPath, entry.name);
  if (entry.isFile() && !publicDeclarations.has(file)) rmSync(file);
}
