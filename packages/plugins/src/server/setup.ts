import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/kernel/mutation-api';
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Context } from 'cordis';
import { DomainError } from '@mini-harness/platform/errors';
import { HttpReply } from '@mini-harness/transport/routes';
import { installPlugin, uninstallPlugin } from './files.js';

/** All local plugin filesystem mutations belong to Plugins. */
export function setup(ctx: Context) {
  const host = () => ({
    paths: { plugins: ctx.harnessState.paths.plugins },
    settings: ctx.harnessSettingsStore.settings,
    plugins: ctx.harnessPluginCatalog
  });
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('plugins'));
  const changed = () => changes.invalidate('plugins');
  add('PATCH', '/api/settings/plugins/:id', async ({ body, params, signal }) => {
    const patch = await body();
    return ctx.harnessMutations.run(async () => {
      await ctx.harnessPluginCatalog.writeBrowserConfig(params.id, patch, signal);
      return { ok: true };
    });
  });
  add('POST', '/api/plugin-requests/:id/:operation', async ({ body, params, signal }) => {
    const input = await body();
    return ctx.harnessPluginCatalog.requestScope(params.id, params.operation, input?.target, input?.input, signal);
  });
  add('GET', '/api/plugins/diagnostics', () => ctx.harnessPluginCatalog.diagnostics());
  add('GET', '/api/plugins', () => ctx.harnessPluginCatalog.metadata());
  add('POST', '/api/plugins/install', async ({ body }) => {
    const bundle = await body(2 * 1024 * 1024);
    return ctx.harnessMutations.run(() => {
      const installed = installPlugin(host(), bundle);
      changed();
      return new HttpReply(201, installed);
    });
  });
  add('DELETE', '/api/plugins/:id', ({ params }) =>
    ctx.harnessMutations.run(async () => {
      const root = join(ctx.harnessState.paths.home, 'plugin-data');
      const directory = lstatSync(root, { throwIfNoEntry: false });
      if (directory && (!directory.isDirectory() || relative(root, realpathSync(root))))
        throw new DomainError('conflict', 'Plugin data directory has been redirected');
      const metadata = await ctx.harnessSettingsStore.forgetPlugin(params.id, () => {
        const remaining = uninstallPlugin(host(), params.id);
        if (directory) rmSync(join(root, params.id), { recursive: true, force: true });
        return remaining;
      });
      changed();
      return metadata;
    }));
}
