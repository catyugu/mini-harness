import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
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
