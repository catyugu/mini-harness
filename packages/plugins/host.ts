import type { Context } from 'cordis';
import { HttpReply } from '../../src/contracts/routes.js';
import { installPlugin, uninstallPlugin, frontendSource } from '../../src/plugins/files.js';

/** All local plugin filesystem mutations and browser source delivery belong to Plugins. */
export function setup(ctx: Context) {
  const host = () => ({
    paths: { plugins: ctx.harnessState.paths.plugins },
    settings: { plugins: ctx.harnessSettings().plugins },
    plugins: ctx.harnessPluginCatalog
  });
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  add('POST', '/api/plugins/install', async ({ body }) => ctx.harnessMutations.run(async () =>
    new HttpReply(201, installPlugin(host(), await body(2 * 1024 * 1024)))));
  add('DELETE', '/api/plugins/:id', ({ params }) =>
    ctx.harnessMutations.run(async () => {
      const metadata = await uninstallPlugin(host(), params.id);
      ctx.harnessSettingsStore.forgetPlugin(params.id);
      return metadata;
    }));
  add('GET', '/api/plugins/:id/web', ({ params }) => ({
    source: frontendSource(host(), params.id),
    config: ctx.harnessPluginCatalog.configuration(params.id)
  }));
}
