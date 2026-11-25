import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import type { BrowserEntry } from '@mini-harness/ui-runtime/bootstrap';
import type { ConfiguredPlugin } from './catalog.ts';

export interface Asset {
  path: string;
  mime: string;
}
export interface BrowserAssets {
  entry: string;
  styles: string[];
  urls: Map<string, Asset>;
}

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function builtinBrowserAssets({
  id,
  browser,
  browserStyles = [],
}: ResolvedPlugin): BrowserAssets | undefined {
  if (!browser) {
    if (browserStyles.length) throw new Error('Browser styles require an entry: ' + id);
    return;
  }
  const root = /^\/packages\/([a-z][a-z0-9-]*)\/src\/browser\//.exec(browser)?.[0];
  if (!root || !browser.endsWith('.js')) throw new Error('Invalid built-in browser entry: ' + id);
  const urls = new Map<string, Asset>();
  for (const url of browserStyles) {
    if (
      !url.startsWith(root) ||
      !/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.css$/.test(url.slice(root.length)) ||
      urls.has(url)
    )
      throw new Error('Invalid built-in browser stylesheet: ' + id);
    urls.set(url, { path: join(packageRoot, url.slice('/packages/'.length)), mime: 'text/css' });
  }
  return { entry: browser, styles: browserStyles, urls };
}

const mimeTypes = new Map([
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.json', 'application/json'],
  ['.wasm', 'application/wasm'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.css', 'text/css'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);
// Only explicitly selected build output is traversed. The plugin directory itself
// is never a public root.
const segment = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
function publicPath(file: string) {
  return file.split('/').every((part) => segment.test(part) && part !== 'node_modules');
}

export function readBrowserAssets(
  id: string,
  folder: string,
  entry: string,
  directory: unknown,
): BrowserAssets {
  if (
    !publicPath(entry) ||
    !['.js', '.mjs'].includes(extname(entry)) ||
    (directory !== undefined && (typeof directory !== 'string' || !publicPath(directory)))
  )
    throw new Error('Invalid browser entry or build directory: ' + id);
  if (entry.includes('/') && (typeof directory !== 'string' || !entry.startsWith(directory + '/')))
    throw new Error('Browser entry must be inside its build directory: ' + id);
  const root = realpathSync(folder);
  const entries = new Map<string, Asset>();
  const signature = createHash('sha256').update(root);
  function add(file: string) {
    const path = join(root, file);
    const info = lstatSync(path);
    const mime = mimeTypes.get(extname(file));
    if (!info.isFile() || info.nlink !== 1 || relative(path, realpathSync(path)) || !mime)
      throw new Error('Invalid browser asset: ' + file);
    signature.update(JSON.stringify([file, info.mtimeMs, info.size]));
    entries.set(file, { path, mime });
  }
  function scan(name: string) {
    const path = join(root, name);
    if (!lstatSync(path).isDirectory() || relative(path, realpathSync(path)))
      throw new Error('Invalid browser build directory: ' + name);
    for (const child of readdirSync(path).sort()) {
      if (!publicPath(child)) continue;
      const file = name + '/' + child;
      const info = lstatSync(join(root, file));
      if (info.isSymbolicLink()) throw new Error('Invalid browser asset: ' + file);
      if (info.isDirectory()) scan(file);
      else if (mimeTypes.has(extname(file))) add(file);
    }
  }
  if (typeof directory === 'string') scan(directory);
  if (!entries.has(entry)) add(entry);
  const prefix = '/plugin-assets/' + id + '/' + signature.digest('hex').slice(0, 20) + '/';
  const urls = new Map([...entries].map(([file, info]) => [prefix + file, info]));
  return {
    entry: prefix + entry,
    styles: [...entries.keys()].filter((file) => extname(file) === '.css').map((file) => prefix + file),
    urls,
  };
}

export function planBrowser(plans: ConfiguredPlugin[], effective: (id: string) => unknown): BrowserEntry[] {
  return plans.flatMap(({ id, descriptor, config, live }) => {
    const resources = descriptor.resources;
    if (!resources) return [];
    return [
      {
        id,
        browser: resources.entry,
        styles: resources.styles,
        config: (effective(id) ?? config) as Record<string, unknown>,
        live,
      },
    ];
  });
}

export function publishBrowser(
  browser: BrowserEntry[],
  plans: ConfiguredPlugin[],
  mounted: (id: string) => boolean,
) {
  const entries = browser.filter(({ id }) => mounted(id));
  const ready = new Set(entries.map(({ id }) => id));
  const resources = plans.filter(({ id }) => ready.has(id));
  return {
    entries,
    assets: new Map(resources.flatMap(({ descriptor }) => [...(descriptor.resources?.urls ?? [])])),
    configurable: new Set(
      resources.filter(({ descriptor }) => descriptor.Config || descriptor.configSchema).map(({ id }) => id),
    ),
  };
}
