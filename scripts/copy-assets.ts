import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const profileModules = new Map<string, { path: string; exportName: string }>();
for (const { name, parentPath } of readdirSync('packages', { withFileTypes: true })) {
  const { miniHarness } = JSON.parse(readFileSync(join(parentPath, name, 'package.json'), 'utf8')) as {
    miniHarness?: { profileModules?: Record<string, string> };
  };
  for (const [specifier, target] of Object.entries(miniHarness?.profileModules ?? {})) {
    const [source, exportName = 'default'] = target.split('#');
    if (!/^@mini-harness\/[a-z][a-z0-9-]*$/.test(specifier) || profileModules.has(specifier))
      throw new Error('Invalid or duplicate Profile plugin: ' + specifier);
    if (
      !/^\.\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts$/.test(source) ||
      !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exportName) ||
      target.split('#').length > 2
    )
      throw new Error('Invalid Profile plugin target: ' + specifier + ' -> ' + target);
    const path = 'packages/' + name + '/' + source.slice(2, -3) + '.js';
    if (!existsSync(join('dist', path))) throw new Error('Missing compiled Profile plugin: ' + specifier);
    profileModules.set(specifier, { path, exportName });
  }
  const source = join(parentPath, name, 'src');
  for (const asset of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!asset.isFile() || asset.name.endsWith('.ts')) continue;
    const file = join(asset.parentPath, asset.name);
    const target = join('dist/packages', name, 'src', relative(source, file));
    mkdirSync(dirname(target), { recursive: true });
    if (asset.name.endsWith('.html')) {
      const html = readFileSync(file, 'utf8').replace(
        /(<script type="module" src=")(\.\.?\/[^"]+\.ts)(")/g,
        (_, start: string, specifier: string, end: string) => {
          const entry = resolve(dirname(target), specifier.replace(/\.ts$/, '.js'));
          const path = relative(resolve('dist'), entry).split(sep).join('/');
          if (!path.startsWith('packages/') || !existsSync(entry))
            throw new Error('Missing HTML module entry: ' + specifier);
          return start + '/' + path + end;
        },
      );
      writeFileSync(target, html);
    } else copyFileSync(file, target);
  }
}

writeFileSync(
  'dist/packages/host/src/profile-modules.json',
  JSON.stringify(Object.fromEntries(profileModules), null, 2) + '\n',
);

mkdirSync('dist/packages/ui-primitives/src/browser/vendor', { recursive: true });
copyFileSync(
  join(dirname(require.resolve('marked')), 'marked.esm.js'),
  'dist/packages/ui-primitives/src/browser/vendor/marked.js',
);
copyFileSync(
  join(dirname(require.resolve('dompurify')), 'purify.es.mjs'),
  'dist/packages/ui-primitives/src/browser/vendor/purify.js',
);
copyFileSync(
  join(dirname(require.resolve('marked')), '..', 'LICENSE'),
  'dist/packages/ui-primitives/src/browser/vendor/marked.LICENSE',
);
copyFileSync(
  join(dirname(require.resolve('dompurify')), '..', 'LICENSE'),
  'dist/packages/ui-primitives/src/browser/vendor/purify.LICENSE',
);

for (const owner of readdirSync('vendor', { withFileTypes: true })) {
  if (!owner.isDirectory()) continue;
  for (const notice of ['LICENSE', 'README.md']) {
    const source = join('vendor', owner.name, notice);
    if (existsSync(source)) copyFileSync(source, join('dist/vendor', owner.name, notice));
  }
}

const editorEntry = 'packages/conversation/src/browser/conversation/editor-vendor.ts';
const editor = await build({
  entryPoints: [editorEntry],
  outfile: 'dist/' + editorEntry.replace(/\.ts$/, '.js'),
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
  const license = readdirSync(directory).find((file) => /^licen[sc]e(?:\.|$)/i.test(file));
  if (!license) throw new Error('Missing license for bundled dependency: ' + name);
  copyFileSync(join(directory, license), join(notices, name.replace(/[^a-zA-Z0-9-]/g, '-') + '.LICENSE'));
}

// Examples are TypeScript sources; only compiled copies are loaded by integration tests.
for (const example of readdirSync('docs/examples', { withFileTypes: true })) {
  if (!example.isDirectory() || example.name === 'task-notes') continue;
  const directory = join('dist/docs/examples', example.name);
  mkdirSync(directory, { recursive: true });
  copyFileSync(join('docs/examples', example.name, 'plugin.json'), join(directory, 'plugin.json'));
}
