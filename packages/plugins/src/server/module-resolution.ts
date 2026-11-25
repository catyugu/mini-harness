import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
export function bindPluginImports(directories: readonly string[]) {
  const roots = directories.map((root) => pathToFileURL(join(root, '.')).href.replace(/\/$/, '') + '/');
  return registerHooks({
    resolve(name, context, next) {
      const entry = sdk.get(name);
      const parent = context.parentURL;
      return next(entry && parent && roots.some((root) => parent.startsWith(root)) ? entry : name, context);
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
