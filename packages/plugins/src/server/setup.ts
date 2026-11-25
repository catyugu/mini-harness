import type { Context } from 'mini-harness/cordis';
import type { ScopeOption } from '../shared/metadata.ts';

/** Publish catalog and configuration. */
export function setup(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('plugins'));
  add('PATCH', '/api/settings/plugins/:id', async ({ body, params, signal }) => {
    const patch = await body();
    return ctx.harnessMutations.run(async () => {
      await ctx.harnessPluginCatalog.writeBrowserConfig(params.id, patch, signal);
      return { ok: true };
    });
  });
  add('GET', '/api/plugins/scopes', () => {
    const options: ScopeOption[] = [];
    ctx.emit('settings/scopes', options);
    return options;
  });
  add('GET', '/api/plugins/diagnostics', () => ctx.harnessPluginCatalog.diagnostics());
  add('GET', '/api/plugins', () => ctx.harnessPluginCatalog.metadata());
}
