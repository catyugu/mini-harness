import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Context } from 'cordis';
import { HttpError, HttpReply } from '@mini-harness/contracts/routes';
import { installPlugin, uninstallPlugin } from './files.js';

/** All local plugin filesystem mutations belong to Plugins. */
export function setup(ctx: Context) {
  const host = () => ({
    paths: { plugins: ctx.harnessState.paths.plugins },
    settings: ctx.harnessSettings(),
    plugins: ctx.harnessPluginCatalog
  });
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const changed = () => ctx.harnessChanges.dispatchEvent(new CustomEvent('change', { detail: { domain: 'plugins' } }));
  add('GET', '/api/plugins/diagnostics', () => ctx.harnessPluginCatalog.diagnostics());
  add('GET', '/api/plugins', () => ctx.harnessPluginCatalog.metadata());
  add('POST', '/api/plugins/install', async ({ body }) => ctx.harnessMutations.run(async () => {
    const installed = installPlugin(host(), await body(2 * 1024 * 1024));
    changed();
    return new HttpReply(201, installed);
  }));
  add('DELETE', '/api/plugins/:id', ({ params }) =>
    ctx.harnessMutations.run(async () => {
      const root = join(ctx.harnessState.paths.home, 'plugin-data');
      const directory = lstatSync(root, { throwIfNoEntry: false });
      if (directory && (!directory.isDirectory() || relative(root, realpathSync(root))))
        throw new HttpError('conflict', 'Plugin data directory has been redirected');
      const metadata = await uninstallPlugin(host(), params.id);
      if (directory) rmSync(join(root, params.id), { recursive: true, force: true });
      ctx.harnessSettingsStore.forgetPlugin(params.id);
      changed();
      return metadata;
    }));
}
