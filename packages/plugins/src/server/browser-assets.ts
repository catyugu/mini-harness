import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type { BrowserEntry } from '@mini-harness/ui-runtime/bootstrap';
import { selectProviders } from './providers.js';
import type { ConfiguredPlugin } from './catalog.js';

export interface Asset {
  path: string;
  mime: string;
}
export interface BrowserAssets {
  entry: string;
  styles: string[];
  preload?: string;
  urls: Map<string, Asset>;
}

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function builtinBrowserAssets({
  id,
  browser,
  browserStyles = [],
}: PluginDescriptor): BrowserAssets | undefined {
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
  ['.css', 'text/css'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);
const publicPath = /^web\/(?:[a-zA-Z0-9][a-zA-Z0-9_-]*\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const sizePerFile = 1024 * 1024;

export function readBrowserAssets(
  id: string,
  folder: string,
  declared: unknown,
  preload: unknown,
): BrowserAssets {
  const files = declared ?? [];
  if (
    !Array.isArray(files) ||
    files.length > 32 ||
    new Set(files).size !== files.length ||
    !files.every(
      (file): file is string =>
        typeof file === 'string' &&
        publicPath.test(file) &&
        !/\.(?:test|spec)\.js$/.test(file) &&
        mimeTypes.has(extname(file)),
    )
  )
    throw new Error('Invalid browserAssets list: ' + id);
  if (
    preload !== undefined &&
    (typeof preload !== 'string' || !files.includes(preload) || extname(preload) !== '.js')
  )
    throw new Error('browserPreload must reference a declared JavaScript asset: ' + id);
  const entries = new Map<string, Asset>();
  const signature = createHash('sha256').update(folder);
  let total = 0;
  for (const file of ['web.js', ...files]) {
    const path = join(folder, file);
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > sizePerFile ||
      relative(path, realpathSync(path)) ||
      (total += info.size) > 8 * sizePerFile
    )
      throw new Error('Invalid browser asset: ' + file);
    signature.update(JSON.stringify([file, info.mtimeMs, info.size]));
    entries.set(file, { path, mime: mimeTypes.get(extname(file))! });
  }
  const prefix = '/plugin-assets/' + id + '/' + signature.digest('hex').slice(0, 20) + '/';
  const urls = new Map([...entries].map(([file, info]) => [prefix + file, info]));
  return {
    entry: prefix + 'web.js',
    preload: preload ? prefix + preload : undefined,
    styles: files.filter((file) => extname(file) === '.css').map((file) => prefix + file),
    urls,
  };
}

export function planBrowser(
  plans: ConfiguredPlugin[],
  choices: Record<string, string>,
  required: ReadonlySet<string>,
): BrowserEntry[] {
  const browser = new Map(
    plans.filter(({ descriptor }) => descriptor.resources).map((plan) => [plan.id, plan]),
  );
  const runtime = new Map(
    ['miniProjections', 'miniSwitch', 'miniBrowserFailures'].map((name) => [name, 'browser-runtime']),
  );
  const { selected } = selectProviders(
    [...browser.values()].map(({ id, descriptor }) => ({
      id,
      provides: descriptor.browserProvides,
    })),
    runtime,
    choices,
  );
  return selected.map((descriptor) => {
    const plan = browser.get(descriptor.id);
    const resources = plan?.descriptor.resources;
    if (!plan || !resources) throw new Error('Composed browser capability is unavailable: ' + descriptor.id);
    return {
      id: plan.id,
      requires: plan.descriptor.browserRequires,
      provides: plan.descriptor.browserProvides,
      browser: resources.entry,
      styles: resources.styles,
      preload: resources.preload,
      config: plan.config ?? {},
      liveConfig: plan.descriptor.configChanges === 'live',
      required:
        plan.descriptor.required || plan.descriptor.browserProvides?.some((name) => required.has(name)),
    };
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
    configurable: new Set(resources.filter(({ descriptor }) => descriptor.configSchema).map(({ id }) => id)),
  };
}
