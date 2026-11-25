import type { Context } from 'mini-harness/cordis';
import type { ScopeOption } from '@mini-harness/plugin-api/scopes';

/** Publish catalog, configuration and scoped plugin requests. */
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
  add('POST', '/api/plugins/:id/scopes/:scope/:operation', async ({ params, body, signal }) =>
    ctx.harnessPluginCatalog.requestScope(
      params.id,
      params.scope,
      params.operation,
      (await body())?.input,
      signal,
    ),
  );
  add('GET', '/api/plugins/scopes', () => {
    const options: ScopeOption[] = [];
    ctx.emit('scopes/list', options);
    return options;
  });
  add('GET', '/api/plugins/diagnostics', () => ctx.harnessPluginCatalog.diagnostics());
  add('GET', '/api/plugins', () => ctx.harnessPluginCatalog.metadata());
}
