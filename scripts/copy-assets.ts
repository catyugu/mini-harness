import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
for (const { name, parentPath } of readdirSync('packages', { withFileTypes: true })) {
  const source = join(parentPath, name, 'src');
  for (const asset of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!asset.isFile() || asset.name.endsWith('.ts')) continue;
    const file = join(asset.parentPath, asset.name);
    const target = join('dist/packages', name, 'src', relative(source, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
}

mkdirSync('dist/packages/ui-runtime/src/browser/vendor', { recursive: true });
mkdirSync('dist/packages/ui-primitives/src/browser/vendor', { recursive: true });
copyFileSync(join(dirname(require.resolve('marked')), 'marked.esm.js'), 'dist/packages/ui-primitives/src/browser/vendor/marked.js');
copyFileSync(join(dirname(require.resolve('dompurify')), 'purify.es.mjs'), 'dist/packages/ui-primitives/src/browser/vendor/purify.js');
copyFileSync(join(dirname(require.resolve('marked')), '..', 'LICENSE'), 'dist/packages/ui-primitives/src/browser/vendor/marked.LICENSE');
copyFileSync(join(dirname(require.resolve('dompurify')), '..', 'LICENSE'), 'dist/packages/ui-primitives/src/browser/vendor/purify.LICENSE');

mkdirSync('dist/types/packages/ui-runtime/src/browser/vendor', { recursive: true });
copyFileSync('packages/ui-runtime/src/browser/vendor/cordis.d.ts', 'dist/types/packages/ui-runtime/src/browser/vendor/cordis.d.ts');
copyFileSync('packages/ui-runtime/src/browser/vendor/cordis.LICENSE', 'dist/packages/ui-runtime/src/browser/vendor/cordis.LICENSE');
const cordis = require.resolve('cordis');
const requireCordis = createRequire(cordis);
writeFileSync('dist/packages/ui-runtime/src/browser/vendor/cordis.js', readFileSync(cordis, 'utf8').replaceAll('"cosmokit"', '"./cosmokit.js"'));
const cosmokit = dirname(requireCordis.resolve('cosmokit'));
copyFileSync(join(cosmokit, 'index.mjs'), 'dist/packages/ui-runtime/src/browser/vendor/cosmokit.js');
copyFileSync(join(cosmokit, '..', 'LICENSE'), 'dist/packages/ui-runtime/src/browser/vendor/cosmokit.LICENSE');
