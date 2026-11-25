import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

const manifest = new URL('../../../../../package.json', import.meta.url);
const { exports: publicModules } = JSON.parse(readFileSync(manifest, 'utf8')) as {
  exports: Record<string, { default: string }>;
};
const sdk = new Map(
  Object.entries(publicModules).map(([name, target]) => [
    'mini-harness' + name.slice(1),
    new URL(target.default, manifest).href,
  ]),
);

/** Resolve the public server SDK from this host for local, npm and development plugins. */
export function bindPluginImports() {
  return registerHooks({
    resolve(name, context, next) {
      return next(sdk.get(name) ?? name, context);
    },
  });
}

/** Resolve a standard ESM specifier relative to the file that declares it. */
export function resolveModule(name: string, source: string) {
  const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;
  const parentURL = pathToFileURL(source).href;
  const hook = registerHooks({
    resolve(request, context, next) {
      return next(
        request,
        request === specifier && context.parentURL === import.meta.url ? { ...context, parentURL } : context,
      );
    },
  });
  try {
    return import.meta.resolve(specifier);
  } finally {
    hook.deregister();
  }
}

/** Load the same native Cordis exports regardless of how the module was located. */
export async function loadPluginModule(url: string, exportName = 'default') {
  const exports = await import(url);
  const value: unknown = exportName === 'default' ? (exports.default ?? exports) : exports[exportName];
  const plugin =
    typeof value === 'function' ||
    (value !== null && typeof value === 'object' && 'apply' in value && typeof value.apply === 'function')
      ? (value as Plugin)
      : undefined;
  const metadata: PluginInfo | undefined =
    exports[exportName === 'default' ? 'metadata' : exportName + 'Metadata'];
  const Config: Plugin.Base['Config'] =
    plugin?.Config ?? exports[exportName === 'default' ? 'Config' : exportName + 'Config'];
  return { plugin, metadata, Config };
}
