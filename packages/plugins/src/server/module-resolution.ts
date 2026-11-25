import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdk = new Map([
  ['mini-harness/cordis', import.meta.resolve('mini-harness/cordis')],
  ['mini-harness/plugin', import.meta.resolve('mini-harness/plugin')],
]);

/** Resolve the public server SDK from this host for local, npm and development plugins. */
export function bindPluginImports(directory: string, devPlugin?: string) {
  const roots = [directory, ...(devPlugin ? [devPlugin] : [])].map((root) =>
    pathToFileURL(join(root, 'plugin.js')).href.slice(0, -'plugin.js'.length),
  );
  return registerHooks({
    resolve(name, context, next) {
      const entry = sdk.get(name);
      const parent = context.parentURL;
      return next(entry && parent && roots.some((root) => parent.startsWith(root)) ? entry : name, context);
    },
  });
}
