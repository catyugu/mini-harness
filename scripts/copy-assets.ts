import { createRequire } from 'node:module';
import { cpSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
mkdirSync('dist/web/vendor', { recursive: true });
for (const asset of ['index.html', 'style.css', 'logo.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon.ico']) {
  copyFileSync(join('web', asset), join('dist/web', asset));
}
copyFileSync(join(dirname(require.resolve('marked')), 'marked.esm.js'), 'dist/web/vendor/marked.js');
copyFileSync(join(dirname(require.resolve('dompurify')), 'purify.es.mjs'), 'dist/web/vendor/purify.js');
copyFileSync(join(dirname(require.resolve('marked')), '..', 'LICENSE'), 'dist/web/vendor/marked.LICENSE');
copyFileSync(join(dirname(require.resolve('dompurify')), '..', 'LICENSE'), 'dist/web/vendor/purify.LICENSE');

copyFileSync('web/vendor/cordis.LICENSE', 'dist/web/vendor/cordis.LICENSE');
const cordis = require.resolve('cordis');
const requireCordis = createRequire(cordis);
writeFileSync('dist/web/vendor/cordis.js', readFileSync(cordis, 'utf8').replaceAll('"cosmokit"', '"./cosmokit.js"'));
const cosmokit = dirname(requireCordis.resolve('cosmokit'));
copyFileSync(join(cosmokit, 'index.mjs'), 'dist/web/vendor/cosmokit.js');
copyFileSync(join(cosmokit, '..', 'LICENSE'), 'dist/web/vendor/cosmokit.LICENSE');

cpSync('web/styles', 'dist/web/styles', { recursive: true });
