import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
mkdirSync('dist/packages/web/vendor', { recursive: true });
for (const asset of ['index.html', 'logo.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon.ico']) {
  copyFileSync(join('packages/web', asset), join('dist/packages/web', asset));
}
writeFileSync('dist/packages/web/theme.css', [
  readFileSync('packages/ui-theme/style.css', 'utf8'),
  readFileSync('packages/ui-primitives/style.css', 'utf8'),
  readFileSync('packages/ui-layout/frame.css', 'utf8'),
  readFileSync('packages/sessions/browser/conversation/style.css', 'utf8'),
  readFileSync('packages/settings/browser.css', 'utf8'),
  readFileSync('packages/ui-layout/responsive.css', 'utf8'),
  readFileSync('packages/plugins/browser.css', 'utf8'),
  readFileSync('packages/ui-layout/panels.css', 'utf8')
].join('\n'));
copyFileSync(join(dirname(require.resolve('marked')), 'marked.esm.js'), 'dist/packages/web/vendor/marked.js');
copyFileSync(join(dirname(require.resolve('dompurify')), 'purify.es.mjs'), 'dist/packages/web/vendor/purify.js');
copyFileSync(join(dirname(require.resolve('marked')), '..', 'LICENSE'), 'dist/packages/web/vendor/marked.LICENSE');
copyFileSync(join(dirname(require.resolve('dompurify')), '..', 'LICENSE'), 'dist/packages/web/vendor/purify.LICENSE');

copyFileSync('packages/web/vendor/cordis.LICENSE', 'dist/packages/web/vendor/cordis.LICENSE');
const cordis = require.resolve('cordis');
const requireCordis = createRequire(cordis);
writeFileSync('dist/packages/web/vendor/cordis.js', readFileSync(cordis, 'utf8').replaceAll('"cosmokit"', '"./cosmokit.js"'));
const cosmokit = dirname(requireCordis.resolve('cosmokit'));
copyFileSync(join(cosmokit, 'index.mjs'), 'dist/packages/web/vendor/cosmokit.js');
copyFileSync(join(cosmokit, '..', 'LICENSE'), 'dist/packages/web/vendor/cosmokit.LICENSE');
