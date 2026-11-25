import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

mkdirSync('dist/packages/ui-primitives/src/browser/vendor', { recursive: true });
copyFileSync(join(dirname(require.resolve('marked')), 'marked.esm.js'), 'dist/packages/ui-primitives/src/browser/vendor/marked.js');
copyFileSync(join(dirname(require.resolve('dompurify')), 'purify.es.mjs'), 'dist/packages/ui-primitives/src/browser/vendor/purify.js');
copyFileSync(join(dirname(require.resolve('marked')), '..', 'LICENSE'), 'dist/packages/ui-primitives/src/browser/vendor/marked.LICENSE');
copyFileSync(join(dirname(require.resolve('dompurify')), '..', 'LICENSE'), 'dist/packages/ui-primitives/src/browser/vendor/purify.LICENSE');


for (const name of ['LICENSE', 'COSMOKIT.LICENSE', 'README.md']) {
  copyFileSync(join('vendor/cordis', name), join('dist/vendor/cordis', name));
}

const editor = await build({
  entryPoints: ['packages/conversation/src/browser/conversation/editor-vendor.ts'],
  outfile: 'dist/packages/conversation/src/browser/conversation/editor-vendor.js',
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  metafile: true,
});

const notices = 'dist/packages/conversation/src/browser/vendor';
mkdirSync(notices, { recursive: true });
for (const path of Object.keys(editor.metafile.inputs)) {
  if (!path.split(/[\\/]/).includes('node_modules')) continue;
  let directory = dirname(path);
  while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
  const { name } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const license = readdirSync(directory).find(file => /^licen[sc]e(?:\.|$)/i.test(file));
  if (!license) throw new Error('Missing license for bundled dependency: ' + name);
  copyFileSync(join(directory, license), join(notices, name.replace(/[^a-zA-Z0-9-]/g, '-') + '.LICENSE'));
}
