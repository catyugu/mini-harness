import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
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
  styles?: string[],
): BrowserAssets {
  if (
    !publicPath(entry) ||
    !['.js', '.mjs'].includes(extname(entry)) ||
    (directory !== undefined && (typeof directory !== 'string' || !publicPath(directory)))
  )
    throw new Error('Invalid browser entry or build directory: ' + id);
  if (entry.includes('/') && typeof directory === 'string' && !entry.startsWith(directory + '/'))
    throw new Error('Browser entry must be inside its build directory: ' + id);
  if (styles !== undefined && (!Array.isArray(styles) || styles.some((style) => typeof style !== 'string')))
    throw new Error('Invalid browser styles: ' + id);
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
  for (const style of styles ?? []) {
    if (!publicPath(style) || extname(style) !== '.css')
      throw new Error('Invalid browser stylesheet: ' + style);
    if (!entries.has(style)) add(style);
  }
  const prefix = '/plugin-assets/' + id + '/' + signature.digest('hex').slice(0, 20) + '/';
  const urls = new Map([...entries].map(([file, info]) => [prefix + file, info]));
  return {
    entry: prefix + entry,
    styles: (styles ?? [...entries.keys()].filter((file) => extname(file) === '.css')).map(
      (file) => prefix + file,
    ),
    urls,
  };
}

export function publishBrowser(
  plans: ConfiguredPlugin[],
  mounted: (id: string) => boolean,
  effective: (id: string) => unknown = () => undefined,
) {
  const entries: BrowserEntry[] = [];
  const assets = new Map<string, Asset>();
  const configurable = new Set<string>();
  for (const { id, resources, config, live, configurable: canConfigure } of plans) {
    if (!resources || !mounted(id)) continue;
    entries.push({
      id,
      browser: resources.entry,
      styles: resources.styles,
      config: (effective(id) ?? config) as Record<string, unknown>,
      live,
    });
    for (const [url, asset] of resources.urls) assets.set(url, asset);
    if (canConfigure) configurable.add(id);
  }
  return { entries, assets, configurable };
}
