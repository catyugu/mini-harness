import type { Context } from 'cordis';
import { HttpReply } from '#mini-harness/contracts/routes.js';
import { installPlugin, uninstallPlugin, frontendSource } from './files.js';

/** All local plugin filesystem mutations and browser source delivery belong to Plugins. */
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
      const metadata = await uninstallPlugin(host(), params.id);
      ctx.harnessSettingsStore.forgetPlugin(params.id);
      changed();
      return metadata;
    }));
  add('GET', '/api/plugins/:id/web', ({ params }) => ({
    source: frontendSource(host(), params.id)
  }));
}
