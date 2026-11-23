import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const mimeTypes = new Map([
  ['.js', 'text/javascript'], ['.css', 'text/css'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'], ['.svg', 'image/svg+xml'], ['.woff2', 'font/woff2']
]);
const publicPath = /^web\/(?:[a-zA-Z0-9][a-zA-Z0-9_-]*\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const sizePerFile = 1024 * 1024;

export function readBrowserAssets(id: string, folder: string, declared: unknown, preload: unknown) {
  const files = declared ?? [];
  if (!Array.isArray(files) || files.length > 32 || new Set(files).size !== files.length ||
      !files.every((file): file is string => typeof file === 'string' && publicPath.test(file) &&
        !/\.(?:test|spec)\.js$/.test(file) && mimeTypes.has(extname(file))))
    throw new Error('Invalid browserAssets list: ' + id);
  if (preload !== undefined && (typeof preload !== 'string' || !files.includes(preload) || extname(preload) !== '.js'))
    throw new Error('browserPreload must reference a declared JavaScript asset: ' + id);
  const entries = new Map<string, { path: string; mime: string }>();
  const signature = createHash('sha256').update(folder);
  let total = 0;
  for (const file of ['web.js', ...files]) {
    const path = join(folder, file);
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > sizePerFile || relative(path, realpathSync(path)) ||
        (total += info.size) > 8 * sizePerFile) throw new Error('Invalid browser asset: ' + file);
    signature.update(JSON.stringify([file, info.mtimeMs, info.size]));
    entries.set(file, { path, mime: mimeTypes.get(extname(file))! });
  }
  const prefix = '/plugin-assets/' + id + '/' + signature.digest('hex').slice(0, 20) + '/';
  const urls = new Map([...entries].map(([file, info]) => [prefix + file, info]));
  return { entry: prefix + 'web.js', preload: preload ? prefix + preload : undefined,
    styles: files.filter((file) => extname(file) === '.css').map((file) => prefix + file), urls };
}
